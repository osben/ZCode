import { databaseStartupControlSchema, databaseStartupStateSchema } from "./database-startup.js";
import { mcpAppInstanceSchema } from "./mcp-apps/instance.js";
import {
  automationSessionCreateTelemetrySchema,
  sessionCreateTelemetrySchema,
} from "./sessionCreateTelemetry.js";
/* eslint-disable max-lines -- Runtime schemas are currently centralized at the shared-package entry point; keep one export surface for now as external relay-payload validation is added. */
import { z } from "zod";
import { networkCaptureControlSchema, networkCaptureBatchSchema } from "./networkCapture.js";
import { browserCommandSchema } from "./browser-use/commands.js";
import { browserCommandResultSchema } from "./browser-use/result.js";
import { modelSelectionSchema } from "./model-selection.js";
import { zcodeProcessDiagnosticSchema } from "./process-diagnostic.js";
import { PROCESS_RESOURCE_CLI_LANES } from "./processResourceTelemetry.js";
import {
  providerProvisioningErrorCodeSchema,
  providerProvisioningTriggerSchema,
} from "./provider-provisioning.js";
import { zcodeProviderSchema } from "./providers.js";
import { REMOTE_ASSET_INSTALL_MODES } from "./remoteAssetInstallMode.js";
import { isKnownRemoteResourcePackageId } from "./remoteResourcePackages.js";
import type { WebRemoteControlAppPayload } from "./web-remote-control.js";
import { PROTOCOL_V4_LIMITS } from "./zcode-protocol-v4/core.js";
import { sessionWorkflowActivitySchema } from "./zcode-protocol-v4/sessions-index-workflow-activity.js";
import {
  webRemoteControlRpcTransportAckSchema,
  webRemoteControlRpcTransportFrameSchema,
} from "./web-remote-control-rpc-transport.js";
import {
  taskOwnerCommandDeliverySchema,
  taskOwnerCommandRequestSchema,
  taskOwnerCommandResultSchema,
  taskRealtimeDeliveredEventSchema,
  taskRealtimeEventSchema,
  taskRealtimeHostDeliveryKindSchema,
  taskRunLeaseAcquireRequestSchema,
  taskRunLeaseResultSchema,
  taskRunLeaseTargetSchema,
  taskStreamMirrorPublishOpSchema,
  taskStreamMirrorTargetSchema,
} from "./task-realtime-core.js";
import { wslUserSchema } from "./wslUserValidation.js";
import { legacyZCodeProviderSchema } from "./zcode-agent-policy.js";
import { errorAttributionSchema } from "./zcode-protocol-v4/snapshot.js";
import {
  zcodeMcpResourceSamplesSchema,
  zcodeMcpTelemetryEventSchema,
  zcodeProcessResourceSampleSchema,
  zcodeToolExecResourceSchema,
} from "./zcode-protocol/index.js";
import { zcodeTaskModeSchema } from "./zcode-task-mode-schema.js";

export {
  appSettingsOccupationEnum,
  appSettingsPatchSchema,
  appSettingsSchema,
  localeSchema,
  postUpdateReleaseNotesPayloadSchema,
} from "./validationAppSettings.js";
export { isValidWslUser, WSL_USER_MAX_LENGTH, wslUserSchema } from "./wslUserValidation.js";
export { zcodeTaskModeSchema } from "./zcode-task-mode-schema.js";

export function formatZodError(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join(".") : "<root>";
      return `${path}: ${issue.message}`;
    })
    .join("; ");
}

export const nonEmptyStringSchema = z.string().trim().min(1);
export const stringArraySchema = z.array(z.string());
// Task04B: the topic physical-frame meter uses the protocol maximum length for bridge/recovery IDs
// as the mobile relay envelope. Do not apply this limit mechanically at the untrusted payload boundary, or the 1 MiB ceiling is only an estimate.
const webRemoteControlTransportIdSchema = nonEmptyStringSchema
  .max(PROTOCOL_V4_LIMITS.transportEnvelopeIdMaxChars)
  .regex(/^[A-Za-z0-9._~-]+$/u);

export const webRemoteControlWorkspaceTargetSchema = z.object({
  workspacePath: nonEmptyStringSchema,
  workspaceIdentity: nonEmptyStringSchema.optional(),
  remoteSessionId: nonEmptyStringSchema.optional(),
  label: nonEmptyStringSchema,
  workspacePurpose: z.enum(["project", "conversation"]).optional(),
  kind: z.enum(["local", "remote"]),
  connectionState: z.enum(["connected", "disconnected", "reconnecting"]).optional(),
  lastConnectionError: z.string().optional(),
});

export const webRemoteControlWorkspaceTargetsSchema = z.array(
  webRemoteControlWorkspaceTargetSchema,
);

export const webRemoteControlReconnectWorkspaceRequestSchema = z.object({
  requestId: nonEmptyStringSchema,
  workspaceKey: nonEmptyStringSchema,
});

export const webRemoteControlReconnectWorkspaceResultSchema = z.union([
  z.object({
    requestId: nonEmptyStringSchema,
    workspaceKey: nonEmptyStringSchema,
    success: z.literal(true),
  }),
  z.object({
    requestId: nonEmptyStringSchema,
    workspaceKey: nonEmptyStringSchema,
    success: z.literal(false),
    error: z.string(),
  }),
]);

export const webRemoteControlTaskTargetSchema = z.object({
  taskId: nonEmptyStringSchema,
  title: z.string(),
  workspacePath: nonEmptyStringSchema,
  workspaceIdentity: nonEmptyStringSchema.optional(),
  remoteSessionId: nonEmptyStringSchema.optional(),
  workspaceLabel: nonEmptyStringSchema,
  workspaceKind: z.enum(["local", "remote"]),
  createdAt: z.number().finite(),
  updatedAt: z.number().finite(),
  provider: zcodeProviderSchema.optional(),
  unreadAt: z.number().finite().optional(),
  displayStatus: z.enum(["idle", "running", "completed", "error"]).optional(),
  hasBackgroundWork: z.boolean().optional(),
  workflowActivity: sessionWorkflowActivitySchema.optional(),
  pinned: z.boolean().optional(),
  archived: z.boolean().optional(),
});

export const webRemoteControlTaskTargetsSchema = z.array(webRemoteControlTaskTargetSchema);

export const webRemoteControlFailureReasonSchema = z.enum([
  "session-not-found",
  "session-expired",
  "session-conflict",
  "workspace-closed",
  "desktop-disconnected",
  "invalid-mobile-connection",
  "desktop-bootstrap-timeout",
  "connection-recovery-timeout",
  "relay-unavailable",
  "unsupported-action",
  "unexpected-error",
]);

export const webRemoteControlExternalWorkspaceBridgeSchema = z.discriminatedUnion("kind", [
  z.object({
    bridgeSessionId: webRemoteControlTransportIdSchema,
    bridgeGeneration: z.number().int().nonnegative().optional(),
    recoveryId: webRemoteControlTransportIdSchema.optional(),
    kind: z.literal("local"),
    workspaceKey: nonEmptyStringSchema,
    workspacePath: nonEmptyStringSchema,
    initialTaskId: nonEmptyStringSchema.optional(),
  }),
  z.object({
    bridgeSessionId: webRemoteControlTransportIdSchema,
    bridgeGeneration: z.number().int().nonnegative().optional(),
    recoveryId: webRemoteControlTransportIdSchema.optional(),
    kind: z.literal("remote"),
    workspaceKey: nonEmptyStringSchema,
    workspacePath: nonEmptyStringSchema,
    workspaceIdentity: nonEmptyStringSchema,
    remoteSessionId: nonEmptyStringSchema,
    initialTaskId: nonEmptyStringSchema.optional(),
  }),
]);

export const webRemoteControlMobileViewStateSchema = z.object({
  activeWorkspaceKey: nonEmptyStringSchema.optional(),
  activeTaskId: nonEmptyStringSchema.optional(),
  updatedAt: z.number().finite(),
});

export const webRemoteControlMobileDeviceInfoSchema = z.object({
  platform: nonEmptyStringSchema,
  version: nonEmptyStringSchema,
  name: nonEmptyStringSchema,
  userAgent: z.string().optional(),
  language: z.string().optional(),
  languages: z.array(z.string()).optional(),
  browserPlatform: z.string().optional(),
  viewport: z
    .object({
      width: z.number().finite(),
      height: z.number().finite(),
      devicePixelRatio: z.number().finite(),
    })
    .optional(),
  screen: z
    .object({
      width: z.number().finite(),
      height: z.number().finite(),
    })
    .optional(),
  timezone: z.string().optional(),
  online: z.boolean().optional(),
  updatedAt: z.number().finite(),
});

export const webRemoteControlWindowBootstrapResultSchema = z.object({
  windowControlSessionId: nonEmptyStringSchema,
  desktopAppVersion: nonEmptyStringSchema.optional(),
  workspaces: webRemoteControlWorkspaceTargetsSchema,
  tasks: webRemoteControlTaskTargetsSchema,
  initialViewState: webRemoteControlMobileViewStateSchema.optional(),
  mobileViewState: webRemoteControlMobileViewStateSchema.optional(),
});

export const webRemoteControlWorkspaceListResultSchema = z.object({
  workspaces: webRemoteControlWorkspaceTargetsSchema,
  tasks: webRemoteControlTaskTargetsSchema.optional(),
  activeWorkspaceKey: nonEmptyStringSchema.optional(),
  activeTaskId: nonEmptyStringSchema.optional(),
});

export const webRemoteControlPlatformMethodSchema = z.enum([
  "isDockerAvailable",
  "listWSLDistros",
  "listDockerContainers",
  "listSSHConfigAliases",
  "loadMcpFromUserDirectory",
  "saveMcpToUserDirectory",
  "migrateLegacyCommonMcp",
  "getInstalledEditors",
  "openInEditor",
  "openInFileManager",
  "openExternalFile",
]);

const webRemoteControlAppPayloadSchemas = [
  z
    .object({ zcode_type: z.literal("telemetry-report"), event: sessionCreateTelemetrySchema })
    .strict(),
  z.object({
    zcode_type: z.literal("bootstrap-request"),
    requestId: nonEmptyStringSchema,
  }),
  z.object({
    zcode_type: z.literal("bootstrap-response"),
    requestId: nonEmptyStringSchema,
    success: z.literal(true),
    result: webRemoteControlWindowBootstrapResultSchema,
  }),
  z.object({
    zcode_type: z.literal("workspace-list-request"),
    requestId: nonEmptyStringSchema,
  }),
  z.object({
    zcode_type: z.literal("workspace-list-response"),
    requestId: nonEmptyStringSchema,
    success: z.literal(true),
    result: webRemoteControlWorkspaceListResultSchema,
  }),
  z.object({
    zcode_type: z.literal("workspace-list-updated"),
    result: webRemoteControlWorkspaceListResultSchema,
  }),
  z.object({
    zcode_type: z.literal("workspace-bridge-open"),
    requestId: nonEmptyStringSchema,
    bridgeSessionId: webRemoteControlTransportIdSchema,
    bridgeGeneration: z.number().int().nonnegative().optional(),
    recoveryId: webRemoteControlTransportIdSchema.optional(),
    workspaceKey: nonEmptyStringSchema,
    taskId: nonEmptyStringSchema.optional(),
  }),
  z.object({
    zcode_type: z.literal("workspace-bridge-ready"),
    requestId: nonEmptyStringSchema,
    bridgeSessionId: webRemoteControlTransportIdSchema,
    bridgeGeneration: z.number().int().nonnegative().optional(),
    recoveryId: webRemoteControlTransportIdSchema.optional(),
    bridge: webRemoteControlExternalWorkspaceBridgeSchema,
  }),
  z.object({
    zcode_type: z.literal("workspace-bridge-error"),
    requestId: nonEmptyStringSchema,
    bridgeSessionId: webRemoteControlTransportIdSchema.optional(),
    bridgeGeneration: z.number().int().nonnegative().optional(),
    recoveryId: webRemoteControlTransportIdSchema.optional(),
    reason: webRemoteControlFailureReasonSchema,
    error: z.string(),
  }),
  z.object({
    zcode_type: z.literal("workspace-reconnect-request"),
    requestId: nonEmptyStringSchema,
    workspaceKey: nonEmptyStringSchema,
  }),
  z.object({
    zcode_type: z.literal("workspace-reconnect-response"),
    requestId: nonEmptyStringSchema,
    workspaceKey: nonEmptyStringSchema,
    success: z.literal(true),
  }),
  z.object({
    zcode_type: z.literal("workspace-reconnect-response"),
    requestId: nonEmptyStringSchema,
    workspaceKey: nonEmptyStringSchema,
    success: z.literal(false),
    error: z.string(),
  }),
  z.object({
    zcode_type: z.literal("mobile-view-state-update"),
    viewState: webRemoteControlMobileViewStateSchema,
    deviceInfo: webRemoteControlMobileDeviceInfoSchema.optional(),
  }),
  z.object({
    zcode_type: z.literal("platform-request"),
    requestId: nonEmptyStringSchema,
    method: webRemoteControlPlatformMethodSchema,
    args: z.unknown().optional(),
  }),
  z.object({
    zcode_type: z.literal("platform-response"),
    requestId: nonEmptyStringSchema,
    method: webRemoteControlPlatformMethodSchema,
    success: z.literal(true),
    result: z.unknown(),
  }),
  z.object({
    zcode_type: z.literal("platform-response"),
    requestId: nonEmptyStringSchema,
    method: webRemoteControlPlatformMethodSchema,
    success: z.literal(false),
    error: z.string(),
  }),
  // Bug fix: 04D-3 must switch fragments/ACKs and the acknowledged adapter atomically.
  // Continuing to accept legacy single-part messages lets raw bytes bypass the ACK/replay owner and the 1 MiB envelope limit.
  webRemoteControlRpcTransportFrameSchema,
  webRemoteControlRpcTransportAckSchema,
  z.object({
    zcode_type: z.literal("bridge-degraded"),
    bridgeSessionId: webRemoteControlTransportIdSchema,
    bridgeGeneration: z.number().int().nonnegative().optional(),
    recoveryId: webRemoteControlTransportIdSchema.optional(),
    reason: z.enum(["rpc-transport-fault", "rpc-frame-gap", "buffer-overflow", "buffer-timeout"]),
    seq: z.number().int().nonnegative().optional(),
    expectedSeq: z.number().int().nonnegative().optional(),
    droppedCount: z.number().int().nonnegative().optional(),
  }),
  z.object({
    zcode_type: z.literal("app-error"),
    requestId: nonEmptyStringSchema.optional(),
    bridgeSessionId: webRemoteControlTransportIdSchema.optional(),
    reason: webRemoteControlFailureReasonSchema,
    error: z.string(),
  }),
  z.object({
    zcode_type: z.literal("mobile-diagnostic"),
    event: z.enum([
      "state-transition",
      "socket-close",
      "socket-error",
      "recover-start",
      "recover-scheduled",
      "pair-status",
      "failure",
    ]),
    timestamp: z.number().int().nonnegative(),
    state: z.string().optional(),
    previousState: z.string().optional(),
    pairStatus: z.enum(["waiting", "matched"]).optional(),
    closeCode: z.number().int().optional(),
    closeReason: z.string().optional(),
    wasClean: z.boolean().optional(),
    wasPaired: z.boolean().optional(),
    failureReason: webRemoteControlFailureReasonSchema.optional(),
    failureMessage: z.string().optional(),
    visibilityState: z.string().optional(),
    online: z.boolean().optional(),
    hiddenDurationMs: z.number().int().nonnegative().optional(),
  }),
] as const;

// Bugfix: Multiple messages in an app payload share zcode_type (for example, platform-response),
// so z.discriminatedUnion("zcode_type") cannot be used directly; duplicate values would make schema initialization fail.
// Keep the same runtime constraints but use a regular union, so untrusted payloads from the external relay
// are still validated mechanically before entering Desktop/Web routing.
export const webRemoteControlAppPayloadSchema = z.union(webRemoteControlAppPayloadSchemas);

export function parseWebRemoteControlAppPayload(
  payload: unknown,
): WebRemoteControlAppPayload | null {
  const result = webRemoteControlAppPayloadSchema.safeParse(payload);
  return result.success ? (result.data as WebRemoteControlAppPayload) : null;
}

export const credentialRecordSchema = z.record(z.string(), z.string());
export const credentialKeySchema = nonEmptyStringSchema;
export const credentialValueSchema = z.string();

export const sshConnectOptionsSchema = z.object({
  kind: z.literal("ssh"),
  host: nonEmptyStringSchema,
  port: z.number().int().positive().max(65535).optional(),
  username: nonEmptyStringSchema,
  sshConfigAlias: nonEmptyStringSchema.optional(),
  password: z.string().optional(),
  privateKeyPath: z.string().optional(),
  privateKeyPassphrase: z.string().optional(),
  assetInstallMode: z.enum(REMOTE_ASSET_INSTALL_MODES).optional(),
  resourcePackages: z
    .object({
      selectedPackageIds: z.array(z.string().refine(isKnownRemoteResourcePackageId)).optional(),
    })
    .optional(),
});

export const wslConnectOptionsSchema = z.object({
  kind: z.literal("wsl"),
  distro: z.string().optional(),
  user: wslUserSchema.optional(),
});

export const dockerConnectOptionsSchema = z.object({
  kind: z.literal("docker"),
  container: nonEmptyStringSchema,
});

export const serverConnectOptionsSchema = z.object({
  kind: z.literal("server"),
  url: z.string().url(),
  name: nonEmptyStringSchema.optional(),
  token: z.string().optional(),
  workspacePath: z.string().optional(),
  serverId: nonEmptyStringSchema.optional(),
});

export const remoteTargetSchema = z.discriminatedUnion("kind", [
  sshConnectOptionsSchema,
  wslConnectOptionsSchema,
  dockerConnectOptionsSchema,
  serverConnectOptionsSchema,
]);

export const helloMessageSchema = z.object({
  type: z.literal("zcode-hello"),
  version: z.string(),
  platform: z.string(),
  arch: z.string(),
  pid: z.number().int(),
});

export const helloAckMessageSchema = z.object({
  type: z.literal("zcode-hello-ack"),
  version: z.string(),
  clientId: nonEmptyStringSchema,
});

export const rendererLogPayloadSchema = z.object({
  level: z.enum(["info", "warn", "error"]),
  args: z.array(z.unknown()),
});

export const taskNotificationPayloadSchema = z.object({
  taskId: nonEmptyStringSchema,
  status: z.enum([
    "completed",
    "failed",
    "permission_request",
    "elicitation_request",
    "feedback_update",
  ]),
  requestId: nonEmptyStringSchema.optional(),
  title: z.string(),
  body: z.string(),
});

export const telemetryRendererContextSchema = z.object({
  clientTimezone: nonEmptyStringSchema,
  clientLanguage: nonEmptyStringSchema,
  screenResolution: nonEmptyStringSchema,
});

export const rendererTelemetryEventPayloadSchema = z.object({
  context: telemetryRendererContextSchema,
  elementName: nonEmptyStringSchema,
  eventRegion: nonEmptyStringSchema,
  eventType: nonEmptyStringSchema,
  eventText: z.string().optional(),
  eventExtraDetail: z.record(z.string(), z.string()),
  userId: z.string().optional(),
  talkId: z.string().optional(),
  messageId: z.string().optional(),
});

export const armsCustomEventPayloadSchema = z.object({
  name: nonEmptyStringSchema,
  group: nonEmptyStringSchema,
  value: z.number().finite().optional(),
  properties: z
    .record(z.string(), z.union([z.string(), z.number().finite(), z.boolean(), z.undefined()]))
    .optional(),
});

export const broadcastMessageSchema = z.object({
  channel: nonEmptyStringSchema,
  payload: z.unknown(),
  sourceWindowId: z.number().int().optional(),
});

export const remoteAssetDirsSchema = z.object({
  mockCdnDir: z.string().optional(),
  remoteCdnBaseUrl: z.string().optional(),
  remoteCdnBaseUrls: z.array(z.string()).optional(),
  remoteCacheDir: z.string().optional(),
});

const hostAgentWarmupTargetSchema = z.object({
  workspacePath: nonEmptyStringSchema,
  workspaceIdentity: nonEmptyStringSchema.optional(),
});

export const hostInitLocalMessageSchema = z.object({
  type: z.literal("init-local"),
  databaseStartupId: z.string().min(1).max(128).optional(),
  hostId: nonEmptyStringSchema.optional(),
  deliveryKind: taskRealtimeHostDeliveryKindSchema.optional(),
  deviceMid: z.string().optional(),
  feedbackApiBase: z.string().url().optional(),
  workspacePath: nonEmptyStringSchema.optional(),
  workspaceIdentity: nonEmptyStringSchema.optional(),
  // Startup prewarms only the active workspace (desktop STARTUP_AGENT_WARMUP_LIMIT = 1), so the protocol layer tightens the limit accordingly.
  agentWarmupTargets: z.array(hostAgentWarmupTargetSchema).max(1).optional(),
  agentSpawnFallbackCwd: nonEmptyStringSchema.optional(),
  zcodeBuiltinProviderConfigFilePath: nonEmptyStringSchema,
  runtimeProcessEnvPatch: z
    .record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), z.string())
    .optional(),
});

export const windowHostRemoteWorkspaceDescriptorSchema = z
  .object({
    remoteSessionId: nonEmptyStringSchema,
    target: remoteTargetSchema,
    workspacePath: nonEmptyStringSchema.optional(),
    workspaceIdentity: nonEmptyStringSchema.optional(),
    generation: z.number().int().positive(),
  })
  .strict();
export type WindowHostRemoteWorkspaceDescriptor = z.infer<
  typeof windowHostRemoteWorkspaceDescriptorSchema
>;

export const windowHostAttachmentScopeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("local") }).strict(),
  z
    .object({
      kind: z.literal("remote"),
      remoteSessionId: nonEmptyStringSchema,
      workspacePath: nonEmptyStringSchema,
      workspaceIdentity: nonEmptyStringSchema,
    })
    .strict(),
]);
export type WindowHostAttachmentScope = z.infer<typeof windowHostAttachmentScopeSchema>;

export const hostConnectRemoteWorkspaceMessageSchema = z
  .object({
    type: z.literal("connect-remote-workspace"),
    requestId: nonEmptyStringSchema,
    target: remoteTargetSchema,
    remoteAssets: remoteAssetDirsSchema,
    workspacePath: nonEmptyStringSchema.optional(),
    workspaceIdentity: nonEmptyStringSchema.optional(),
  })
  .strict();

export const hostCancelRemoteWorkspaceConnectMessageSchema = z
  .object({
    type: z.literal("cancel-remote-workspace-connect"),
    requestId: nonEmptyStringSchema,
  })
  .strict();

export const hostBindRemoteWorkspaceContextMessageSchema = z
  .object({
    type: z.literal("bind-remote-workspace-context"),
    requestId: nonEmptyStringSchema,
    remoteSessionId: nonEmptyStringSchema,
    workspacePath: nonEmptyStringSchema,
    workspaceIdentity: nonEmptyStringSchema,
  })
  .strict();

export const hostDisposeRemoteWorkspaceSessionMessageSchema = z
  .object({
    type: z.literal("dispose-remote-workspace-session"),
    requestId: nonEmptyStringSchema,
    remoteSessionId: nonEmptyStringSchema,
  })
  .strict();

export const hostAttachServicePortMessageSchema = z
  .object({
    type: z.literal("attach-service-port"),
    // main can declare only the attachment source; the host process still assigns connectionId.
    // Desktop reload/remote reattach must explicitly use continuous; mobile shared-host must use replayable.
    requestId: nonEmptyStringSchema,
    attachmentId: nonEmptyStringSchema,
    clientMode: z.enum(["desktop-continuous", "web-remote-replayable"]),
    scope: windowHostAttachmentScopeSchema,
  })
  .strict();

export const hostDetachServicePortMessageSchema = z.object({
  type: z.literal("detach-service-port"),
  attachmentId: nonEmptyStringSchema,
});

export const hostDisposeMessageSchema = z.object({
  type: z.literal("dispose"),
});

export const hostBroadcastEnvelopeSchema = z.object({
  type: z.literal("broadcast"),
  message: broadcastMessageSchema,
});

export const hostBroadcastClaimResultMessageSchema = z.discriminatedUnion("status", [
  z.object({
    type: z.literal("broadcast-claim-result"),
    requestId: nonEmptyStringSchema,
    status: z.literal("acquired"),
    claimToken: nonEmptyStringSchema,
  }),
  z.object({
    type: z.literal("broadcast-claim-result"),
    requestId: nonEmptyStringSchema,
    status: z.literal("busy"),
    retryAfterMs: z.number().int().nonnegative(),
  }),
  z.object({
    type: z.literal("broadcast-claim-result"),
    requestId: nonEmptyStringSchema,
    status: z.literal("committed"),
  }),
]);

export const hostTaskRealtimeDeliverMessageSchema = z.object({
  type: z.literal("task-realtime-deliver"),
  event: taskRealtimeDeliveredEventSchema,
});

export const hostTaskRunLeaseResultMessageSchema = z.object({
  type: z.literal("task-run-lease-result"),
  result: taskRunLeaseResultSchema,
});

export const hostTaskOwnerCommandDeliverMessageSchema = z.object({
  type: z.literal("task-owner-command-deliver"),
  command: taskOwnerCommandDeliverySchema,
});

export const hostTaskOwnerCommandResultMessageSchema = z.object({
  type: z.literal("task-owner-command-result"),
  result: taskOwnerCommandResultSchema,
});

export const hostBotRemoteWorkspaceReconnectResultMessageSchema = z.object({
  type: z.literal("bot-remote-workspace-reconnect-result"),
  requestId: nonEmptyStringSchema,
  ok: z.boolean(),
  sessionId: nonEmptyStringSchema.optional(),
  error: z.string().optional(),
});

export const hostBotRemoteWorkspaceConnectionStatusResultMessageSchema = z.object({
  type: z.literal("bot-remote-workspace-connection-status-result"),
  requestId: nonEmptyStringSchema,
  ok: z.boolean(),
  connected: z.boolean().optional(),
  error: z.string().optional(),
});

export const hostBotRemoteWorkspaceRuntimePortMessageSchema = z.object({
  type: z.literal("bot-remote-workspace-runtime-port"),
  requestId: nonEmptyStringSchema,
  ok: z.boolean(),
  error: z.string().optional(),
});

export const sessionMessageRequestSchema = z.object({
  content: nonEmptyStringSchema,
  createdAt: nonEmptyStringSchema,
  fromSessionId: nonEmptyStringSchema,
  messageId: nonEmptyStringSchema,
  requestId: nonEmptyStringSchema,
  toSessionId: nonEmptyStringSchema,
});

export const sessionMessageDeliveryResultSchema = z.object({
  error: z.string().optional(),
  messageId: nonEmptyStringSchema,
  requestId: nonEmptyStringSchema,
  sessionId: nonEmptyStringSchema,
  status: z.enum(["success", "failed"]),
});

export const sessionRouteSchema = z.object({
  sessionId: nonEmptyStringSchema,
});

export const hostSessionMessageDeliverMessageSchema = z.object({
  type: z.literal("session-message-deliver"),
  request: sessionMessageRequestSchema,
});

export const hostSessionMessageDeliveryResultMessageSchema = z.object({
  type: z.literal("session-message-delivery-result"),
  result: sessionMessageDeliveryResultSchema,
});

export const hostFeedbackLogArchiveResultMessageSchema = z.object({
  type: z.literal("feedback-log-archive-result"),
  requestId: nonEmptyStringSchema,
  ok: z.boolean(),
  path: z.string().optional(),
  size: z.number().int().nonnegative().optional(),
  error: z.string().optional(),
});

// main → host: dispatch a scheduled task when it is due. A session-bound cron with targetTaskId sends
// the prompt directly to the current session; only older unbound tasks fall back to createTask + sendPrompt.
export const hostCronRunMessageSchema = z.object({
  type: z.literal("cron-run"),
  automationId: nonEmptyStringSchema,
  runId: nonEmptyStringSchema,
  workspacePath: nonEmptyStringSchema,
  workspaceIdentity: z.string().optional(),
  prompt: nonEmptyStringSchema,
  targetTaskId: nonEmptyStringSchema.optional(),
  modelSelection: modelSelectionSchema.optional(),
  mode: z.string().optional(),
});

// main → host: dispatch an off-peak task (mirrors cron-run but uses independent fields). The first run
// omits conversationId/sessionId and the host creates a new session with createTask. A three-hour
// continuation or interrupted recovery includes both to resume the same session.
// The idle-plan adapter uses serverTicketId to inject the run-scoped X-Off-Peak-Ticket-ID header.
export const hostOffPeakRunMessageSchema = z.object({
  type: z.literal("off-peak-run"),
  offPeakTaskId: nonEmptyStringSchema,
  workspacePath: nonEmptyStringSchema,
  workspaceIdentity: z.string().optional(),
  prompt: nonEmptyStringSchema,
  // The four permission levels map to the existing ZCodeTaskMode; like cron-run mode, transmit as a
  // permissive string.
  permissionMode: nonEmptyStringSchema,
  modelSelection: modelSelectionSchema,
  conversationId: z.string().optional(),
  sessionId: z.string().optional(),
  serverTicketId: z.string().optional(),
});

// main → host: result of a browser-use command, matched to the host's pending request by requestId.
export const hostBrowserExecuteResultMessageSchema = z.object({
  type: z.literal("browser-execute-result"),
  requestId: nonEmptyStringSchema,
  result: browserCommandResultSchema,
});

export const hostLocalMediaPreviewPathAuthorizeResultMessageSchema = z
  .object({
    type: z.literal("local-media-preview-path-authorize-result"),
    requestId: nonEmptyStringSchema,
    ok: z.boolean(),
    path: nonEmptyStringSchema.optional(),
    error: z.string().optional(),
  })
  .strict();

/** main → host: plugin UI sandbox registration result (PluginSandboxRegisterResultPayload). */
export const hostPluginSandboxRegisterResultMessageSchema = z
  .object({
    type: z.literal("plugin-sandbox-register-result"),
    requestId: nonEmptyStringSchema,
    ok: z.boolean(),
    instance: mcpAppInstanceSchema.optional(),
    sandboxId: nonEmptyStringSchema.optional(),
    initId: z.number().int().nonnegative().optional(),
    shellUrl: nonEmptyStringSchema.optional(),
    partition: nonEmptyStringSchema.optional(),
    // Presentation fields effective at registration (after resource-level overrides are merged), returned to the renderer to set the initial height/border.
    // Bug fix: this schema is strict—a handle containing one undeclared field makes the host reject the entire response, leaving the bridge waiting forever for a handle,
    // and the card stuck in preparing (reproduced in inline E2E on 2026-09-12). Changes to PluginSandboxHandle must be reflected here.
    resourceMeta: z
      .object({
        prefersBorder: z.boolean().optional(),
        heightHint: z.number().int().positive().optional(),
        minFrameHeight: z.number().int().positive().optional(),
        showInline: z.boolean().optional(),
        // Browser permissions declared by the resource are returned to the renderer with the handle (in hostContext.permissions); they use the same enum as registration permissions.
        permissions: z
          .array(z.enum(["camera", "microphone", "geolocation", "clipboardWrite"]))
          .optional(),
      })
      .strict()
      .optional(),
    error: z.string().optional(),
  })
  .strict();

export const hostCuaPipFocusChangedMessageSchema = z
  .object({
    type: z.literal("cua-pip-focus-changed"),
    event: z
      .object({
        kind: z.literal("focus-changed"),
        revision: z.number().int().nonnegative().safe(),
        sourceWindowId: nonEmptyStringSchema.max(255),
        sessionId: nonEmptyStringSchema.max(255).nullable(),
      })
      .strict(),
  })
  .strict();

export const hostProviderProvisioningExecuteMessageSchema = z
  .object({
    type: z.literal("provider-provisioning-execute"),
    requestId: nonEmptyStringSchema,
    environmentKey: nonEmptyStringSchema,
    remoteSessionId: nonEmptyStringSchema,
    trigger: providerProvisioningTriggerSchema,
  })
  .strict();

export const hostResourceUsageSnapshotRequestMessageSchema = z
  .object({
    type: z.literal("resource-usage-snapshot-request"),
    requestId: nonEmptyStringSchema,
  })
  .strict();
export type HostResourceUsageSnapshotRequestMessage = z.infer<
  typeof hostResourceUsageSnapshotRequestMessageSchema
>;

export const hostIncomingMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("network-capture"), control: networkCaptureControlSchema }).strict(),
  z
    .object({ type: z.literal("database-startup-control"), control: databaseStartupControlSchema })
    .strict(),
  hostResourceUsageSnapshotRequestMessageSchema,
  z
    .object({ type: z.literal("resource-usage-snapshot-cancel"), requestId: nonEmptyStringSchema })
    .strict(),
  hostInitLocalMessageSchema,
  hostConnectRemoteWorkspaceMessageSchema,
  hostCancelRemoteWorkspaceConnectMessageSchema,
  hostBindRemoteWorkspaceContextMessageSchema,
  hostDisposeRemoteWorkspaceSessionMessageSchema,
  hostAttachServicePortMessageSchema,
  hostDetachServicePortMessageSchema,
  hostDisposeMessageSchema,
  hostBroadcastEnvelopeSchema,
  hostBroadcastClaimResultMessageSchema,
  hostTaskRealtimeDeliverMessageSchema,
  hostTaskRunLeaseResultMessageSchema,
  hostTaskOwnerCommandDeliverMessageSchema,
  hostTaskOwnerCommandResultMessageSchema,
  hostBotRemoteWorkspaceReconnectResultMessageSchema,
  hostBotRemoteWorkspaceConnectionStatusResultMessageSchema,
  hostBotRemoteWorkspaceRuntimePortMessageSchema,
  hostSessionMessageDeliverMessageSchema,
  hostSessionMessageDeliveryResultMessageSchema,
  hostFeedbackLogArchiveResultMessageSchema,
  hostCronRunMessageSchema,
  hostOffPeakRunMessageSchema,
  hostBrowserExecuteResultMessageSchema,
  hostLocalMediaPreviewPathAuthorizeResultMessageSchema,
  hostPluginSandboxRegisterResultMessageSchema,
  hostCuaPipFocusChangedMessageSchema,
  hostProviderProvisioningExecuteMessageSchema,
]);

export const hostRemoteWorkspaceConnectedResponseSchema = z
  .object({
    type: z.literal("remote-workspace-connected"),
    requestId: nonEmptyStringSchema,
    descriptor: windowHostRemoteWorkspaceDescriptorSchema,
  })
  .strict();

export const hostRemoteWorkspaceConnectionLogResponseSchema = z
  .object({
    type: z.literal("remote-workspace-connection-log"),
    requestId: nonEmptyStringSchema,
    level: z.enum(["info", "warn", "error"]),
    message: nonEmptyStringSchema,
  })
  .strict();

export const hostRemoteWorkspaceConnectFailedResponseSchema = z
  .object({
    type: z.literal("remote-workspace-connect-failed"),
    requestId: nonEmptyStringSchema,
    error: nonEmptyStringSchema,
  })
  .strict();

export const hostRemoteWorkspaceClosedResponseSchema = z
  .object({
    type: z.literal("remote-workspace-closed"),
    remoteSessionId: nonEmptyStringSchema,
    reason: z.enum(["connection-closed", "disposed", "connect-cancelled"]),
    exitCode: z.number().int().nullable().optional(),
    signal: z.string().nullable().optional(),
    error: z.string().optional(),
  })
  .strict();

export const hostLogResponseSchema = z.object({
  type: z.literal("log"),
  level: z.enum(["info", "warn", "error"]),
  source: z.string(),
  message: z.string(),
});

export { zcodeProviderSchema };

export const zcodeTaskMigrationSourceSchema = z.enum(["claudeCode"]);

export const hostAgentProcessSpawnedResponseSchema = z.object({
  type: z.literal("agent-process-spawned"),
  /** Process lane (such as mcp-status); older Hosts omit this field. */
  lane: nonEmptyStringSchema.optional(),
  pid: z.number().int().positive(),
  provider: zcodeProviderSchema,
  workspacePath: nonEmptyStringSchema,
  command: z.string(),
  args: z.array(z.string()),
  startedAt: z.number().int().nonnegative(),
  runtimeGeneration: z.number().int().positive().optional(),
  runtimeInstanceId: nonEmptyStringSchema.optional(),
});
export type HostAgentProcessSpawnedResponse = z.infer<typeof hostAgentProcessSpawnedResponseSchema>;

export const hostAgentProcessReadyResponseSchema = z.object({
  type: z.literal("agent-process-ready"),
  /** Process lane (such as mcp-status); older Hosts omit this field. */
  lane: nonEmptyStringSchema.optional(),
  pid: z.number().int().positive(),
  provider: zcodeProviderSchema,
  workspacePath: nonEmptyStringSchema,
  readyAt: z.number().int().nonnegative(),
  startupDurationMs: z.number().int().nonnegative(),
  runtimeGeneration: z.number().int().positive(),
  runtimeInstanceId: nonEmptyStringSchema,
});
export type HostAgentProcessReadyResponse = z.infer<typeof hostAgentProcessReadyResponseSchema>;

export const hostAgentProcessExitedResponseSchema = z.object({
  type: z.literal("agent-process-exited"),
  /** Process lane (such as mcp-status); older Hosts omit this field. */
  lane: nonEmptyStringSchema.optional(),
  pid: z.number().int().positive(),
  provider: zcodeProviderSchema,
  workspacePath: nonEmptyStringSchema,
  exitCode: z.number().int().nullable(),
  signal: z.string().nullable(),
  endedAt: z.number().int().nonnegative(),
  terminationKind: z.enum(["expected", "unexpected", "watchdog_recycle"]),
  terminationReason: z.string().optional(),
  /** Rolling-upgrade compatibility: when an older Host omits this field, desktop maps crash_phase to unknown. */
  runtimeReady: z.boolean().optional(),
  runtimeGeneration: z.number().int().positive(),
  runtimeInstanceId: nonEmptyStringSchema.optional(),
  uptimeMs: z.number().int().nonnegative(),
  stderrLineCount: z.number().int().nonnegative(),
  stderrTail: z.array(z.string().max(1_100)).max(20).optional(),
});

export type HostAgentProcessExitedResponse = z.infer<typeof hostAgentProcessExitedResponseSchema>;

export const hostAgentProcessErrorResponseSchema = z.object({
  type: z.literal("agent-process-error"),
  /** Process lane (such as mcp-status); older Hosts omit this field. */
  lane: nonEmptyStringSchema.optional(),
  pid: z.number().int().positive().nullable(),
  provider: zcodeProviderSchema,
  workspacePath: nonEmptyStringSchema,
  command: z.string(),
  args: z.array(z.string()),
  errorName: nonEmptyStringSchema,
  errorCode: z.string().optional(),
  errorMessage: z.string(),
  errorStack: z.string().optional(),
  runtimeGeneration: z.number().int().positive(),
  runtimeInstanceId: nonEmptyStringSchema.optional(),
  occurredAt: z.number().int().nonnegative(),
});

export type HostAgentProcessErrorResponse = z.infer<typeof hostAgentProcessErrorResponseSchema>;

export const hostAgentProcessExceptionResponseSchema = z
  .object({
    type: z.literal("agent-process-exception"),
    lane: nonEmptyStringSchema.optional(),
    pid: z.number().int().positive(),
    provider: zcodeProviderSchema,
    workspacePath: nonEmptyStringSchema,
    runtimeGeneration: z.number().int().positive(),
    runtimeInstanceId: nonEmptyStringSchema,
    diagnostic: zcodeProcessDiagnosticSchema,
  })
  .strict();
export type HostAgentProcessExceptionResponse = z.infer<
  typeof hostAgentProcessExceptionResponseSchema
>;

/**
 * CLI resource sample tagged by services.
 *
 * `lane` is not a CLI protocol field: the CLI process does not know which process manager launched it.
 * The services layer adds it while parsing the protocol sample, based on the owning process manager.
 * The sample itself is still strictly validated against the CLI protocol schema, so a lane supplied by
 * the CLI is rejected by the protocol layer. `lane` is optional for compatibility with older remote
 * servers that do not add the tag yet.
 */
export const processResourceCliLaneSchema = z.enum(PROCESS_RESOURCE_CLI_LANES);
export const agentLaneResourceSampleSchema = zcodeProcessResourceSampleSchema
  .extend({ lane: processResourceCliLaneSchema.optional() })
  .strict();
export type AgentLaneResourceSample = z.infer<typeof agentLaneResourceSampleSchema>;

/** Host sends only a SHA-256 hash of the runtime environment so raw host, user, or URL data does not enter messages or logs. */
const resourceTelemetryEnvironmentKeySchema = z.string().regex(/^[a-f0-9]{64}$/);

export const hostAgentResourceSampleResponseSchema = z
  .object({
    type: z.literal("agent-resource-sample"),
    runtimeSurface: z.enum(["local", "remote"]),
    environmentKey: resourceTelemetryEnvironmentKeySchema.optional(),
    sample: agentLaneResourceSampleSchema,
  })
  .strict();
export type HostAgentResourceSampleResponse = z.infer<typeof hostAgentResourceSampleResponseSchema>;

/**
 * Instantaneous facts sampled every 60 seconds by Node processes (host / scheduler).
 *
 * Include only these three values: main's `getAppMetrics()` provides CPU and RSS, while only the process
 * itself can read its heap.
 */
export const nodeSelfResourceSampleSchema = z
  .object({
    /**
     * Whole-machine normalized CPU percentage; 100 means all logical cores are fully occupied.
     * The upper bound is intentionally permissive, matching CLI's `zcodeProcessResourceSampleSchema`:
     * when a reading is anomalous, allow the sample to carry the unusual value so platform-side
     * anomaly rules can surface it instead of silently dropping the sample on the client.
     */
    cpuPercent: z.number().finite().nonnegative().max(100_000),
    rssKb: z.number().finite().nonnegative().max(Number.MAX_SAFE_INTEGER),
    heapUsedKb: z.number().finite().nonnegative().max(Number.MAX_SAFE_INTEGER),
  })
  .strict();
export type NodeSelfResourceSample = z.infer<typeof nodeSelfResourceSampleSchema>;

/**
 * Heap readings sent from the main-window renderer to main through the preload bridge every 60 seconds.
 *
 * Include only heap: main's `getAppMetrics()` provides renderer CPU and RSS, which the renderer cannot
 * read itself. `strict` prevents the UI from including private fields such as paths or sessions.
 */
export const rendererHeapSampleSchema = z
  .object({
    heapUsedKb: z.number().finite().nonnegative().max(Number.MAX_SAFE_INTEGER),
  })
  .strict();
export type RendererHeapSample = z.infer<typeof rendererHeapSampleSchema>;

export const hostResourceSampleResponseSchema = z
  .object({
    type: z.literal("host-resource-sample"),
    sample: nodeSelfResourceSampleSchema,
  })
  .strict();
export type HostResourceSampleResponse = z.infer<typeof hostResourceSampleResponseSchema>;

export const hostMcpResourceSamplesResponseSchema = z
  .object({
    type: z.literal("mcp-resource-samples"),
    runtimeSurface: z.enum(["local", "remote"]),
    environmentKey: resourceTelemetryEnvironmentKeySchema.optional(),
    samples: zcodeMcpResourceSamplesSchema,
  })
  .strict();
export type HostMcpResourceSamplesResponse = z.infer<typeof hostMcpResourceSamplesResponseSchema>;

export const hostToolExecResourceResponseSchema = z
  .object({
    type: z.literal("tool-exec-resource"),
    runtimeSurface: z.enum(["local", "remote"]),
    sample: zcodeToolExecResourceSchema,
  })
  .strict();
export type HostToolExecResourceResponse = z.infer<typeof hostToolExecResourceResponseSchema>;

export const hostMcpTelemetryResponseSchema = z
  .object({
    type: z.literal("mcp-telemetry"),
    runtimeSurface: z.enum(["local", "remote"]),
    event: zcodeMcpTelemetryEventSchema,
  })
  .strict();
export type HostMcpTelemetryResponse = z.infer<typeof hostMcpTelemetryResponseSchema>;

export const hostSessionCreateTelemetryResponseSchema = z
  .object({
    type: z.literal("session-create-telemetry"),
    event: automationSessionCreateTelemetrySchema,
  })
  .strict();
export type HostSessionCreateTelemetryResponse = z.infer<
  typeof hostSessionCreateTelemetryResponseSchema
>;

export const hostAgentRunningTaskCountChangedResponseSchema = z.object({
  type: z.literal("agent-running-task-count-changed"),
  runningTaskCount: z.number().int().nonnegative(),
});

export const hostWorkspaceRunningTaskCountChangedResponseSchema = z.object({
  type: z.literal("workspace-running-task-count-changed"),
  workspacePath: nonEmptyStringSchema,
  workspaceIdentity: nonEmptyStringSchema.optional(),
  runningTaskCount: z.number().int().nonnegative(),
});

export const hostCuaOperationStateResponseSchema = z
  .object({
    type: z.literal("cua-operation-state"),
    active: z.boolean(),
    sessionId: nonEmptyStringSchema,
    turnId: nonEmptyStringSchema,
    workspacePath: nonEmptyStringSchema,
    workspaceIdentity: nonEmptyStringSchema.optional(),
  })
  .strict();

export type HostCuaOperationStateResponse = z.infer<typeof hostCuaOperationStateResponseSchema>;

export const hostBroadcastClaimRequestResponseSchema = z.object({
  type: z.literal("broadcast-claim-request"),
  requestId: nonEmptyStringSchema,
  key: nonEmptyStringSchema.max(1_024),
});

export const hostBroadcastClaimCommitResponseSchema = z.object({
  type: z.literal("broadcast-claim-commit"),
  key: nonEmptyStringSchema.max(1_024),
  claimToken: nonEmptyStringSchema,
});

export const hostBroadcastClaimReleaseResponseSchema = z.object({
  type: z.literal("broadcast-claim-release"),
  key: nonEmptyStringSchema.max(1_024),
  claimToken: nonEmptyStringSchema,
});

export const hostTaskRealtimePublishResponseSchema = z.object({
  type: z.literal("task-realtime-publish"),
  event: taskRealtimeEventSchema,
});

export const hostTaskStreamOpPublishResponseSchema = z.object({
  type: z.literal("task-stream-op-publish"),
  target: taskStreamMirrorTargetSchema,
  op: taskStreamMirrorPublishOpSchema,
});

export const hostTaskRunLeaseAcquireResponseSchema = z.object({
  type: z.literal("task-run-lease-acquire"),
  request: taskRunLeaseAcquireRequestSchema,
});

export const hostTaskRunLeaseReleaseResponseSchema = z.object({
  type: z.literal("task-run-lease-release"),
  target: taskRunLeaseTargetSchema,
});

export const hostTaskOwnerCommandRequestResponseSchema = z.object({
  type: z.literal("task-owner-command-request"),
  command: taskOwnerCommandRequestSchema,
});

export const hostTaskOwnerCommandResultResponseSchema = z.object({
  type: z.literal("task-owner-command-result"),
  result: taskOwnerCommandResultSchema,
});

export const hostBotRemoteWorkspaceReconnectRequestResponseSchema = z.object({
  type: z.literal("bot-remote-workspace-reconnect-request"),
  requestId: nonEmptyStringSchema,
  workspacePath: nonEmptyStringSchema,
  workspaceIdentity: nonEmptyStringSchema,
  target: remoteTargetSchema,
});

export const hostBotRemoteWorkspaceConnectionStatusRequestResponseSchema = z.object({
  type: z.literal("bot-remote-workspace-connection-status-request"),
  requestId: nonEmptyStringSchema,
  workspacePath: nonEmptyStringSchema,
  workspaceIdentity: nonEmptyStringSchema,
  target: remoteTargetSchema,
});

export const hostBotRemoteWorkspaceRuntimePortRequestResponseSchema = z.object({
  type: z.literal("bot-remote-workspace-runtime-port-request"),
  requestId: nonEmptyStringSchema,
  workspacePath: nonEmptyStringSchema,
  workspaceIdentity: nonEmptyStringSchema,
  target: remoteTargetSchema,
});

export const hostSessionMessageSendRequestedResponseSchema = z.object({
  type: z.literal("session-message-send-requested"),
  request: sessionMessageRequestSchema,
});

export const hostSessionRouteAnnounceResponseSchema = z.object({
  type: z.literal("session-route-announce"),
  route: sessionRouteSchema,
});

export const hostSessionMessageDeliverResultResponseSchema = z.object({
  type: z.literal("session-message-deliver-result"),
  result: sessionMessageDeliveryResultSchema,
});

export const hostFeedbackLogArchiveRequestResponseSchema = z.object({
  type: z.literal("feedback-log-archive-request"),
  requestId: nonEmptyStringSchema,
  sourceDir: nonEmptyStringSchema,
});

// host → main: scheduled-task dispatch result. ok means the session was created and the prompt was sent.
export const hostCronRunResultResponseSchema = z.object({
  type: z.literal("cron-run-result"),
  runId: nonEmptyStringSchema,
  ok: z.boolean(),
  taskId: z.string().optional(),
  sessionId: z.string().optional(),
  error: z.string().optional(),
  failureKind: z.enum(["transient", "permanent"]).optional(),
});

// host → main: off-peak task dispatch result. ok means the session exists and the prompt was sent; use
// offPeakTaskId to reconcile a late result.
export const hostOffPeakRunResultResponseSchema = z.object({
  type: z.literal("off-peak-run-result"),
  offPeakTaskId: nonEmptyStringSchema,
  ok: z.boolean(),
  conversationId: z.string().optional(),
  sessionId: z.string().optional(),
  error: z.string().optional(),
  failureKind: z.enum(["transient", "permanent"]).optional(),
});

// host → main: wake the scheduler after a manual run is persisted; the scheduler still reads business data from sqlite.
export const hostCronSchedulerWakeRequestResponseSchema = z.object({
  type: z.literal("cron-scheduler-wake-request"),
  automationId: nonEmptyStringSchema,
});

// host → main: wake the scheduler after an off-peak task becomes schedulable; the scheduler still reads business data from sqlite.
export const hostOffPeakSchedulerWakeRequestResponseSchema = z.object({
  type: z.literal("off-peak-scheduler-wake-request"),
  offPeakTaskId: z.string().optional(),
});

// host → main: execute one browser-use command (main executes it through WebContentsView + CDP).
export const hostBrowserExecuteRequestResponseSchema = z.object({
  type: z.literal("browser-execute-request"),
  requestId: nonEmptyStringSchema,
  // Migration compatibility: older host bundles omit browserId/context; the new browser-client path always includes them.
  browserId: nonEmptyStringSchema.optional(),
  browserGeneration: z.number().int().nonnegative().optional(),
  sessionId: nonEmptyStringSchema,
  turnId: nonEmptyStringSchema.optional(),
  workspaceKey: nonEmptyStringSchema.optional(),
  workspacePath: nonEmptyStringSchema.optional(),
  workspaceIdentity: nonEmptyStringSchema.optional(),
  remoteSessionId: nonEmptyStringSchema.optional(),
  clientMode: z.enum(["desktop-continuous", "web-remote-replayable"]).optional(),
  sessionContext: z.enum(["live", "cached"]).optional(),
  command: browserCommandSchema,
});

export const hostLocalMediaPreviewPathAuthorizeRequestResponseSchema = z
  .object({
    type: z.literal("local-media-preview-path-authorize-request"),
    requestId: nonEmptyStringSchema,
    path: nonEmptyStringSchema,
  })
  .strict();

/** host → main: register validated plugin UI HTML. */
export const hostPluginSandboxRegisterRequestResponseSchema = z
  .object({
    type: z.literal("plugin-sandbox-register-request"),
    instance: mcpAppInstanceSchema,
    requestId: nonEmptyStringSchema,
    workspacePath: z.string().optional(),
    workspaceIdentity: z.string().optional(),
    ownerWebContentsId: z.number().int().nonnegative(),
    sessionId: nonEmptyStringSchema,
    contentKind: z.literal("gen-ui").optional(),
    pluginId: nonEmptyStringSchema.optional(),
    // Runtime name of the MCP server owning the resource; the sandbox partition is derived from it.
    serverName: nonEmptyStringSchema.optional(),
    // Sandbox scope ID (`tool:<toolCallId>` / `surface:<surfaceId>`); main treats it as an opaque string.
    scopeId: nonEmptyStringSchema,
    html: z.string(),
    // The four domain types for MCP Apps resource-level CSP; keep in sync with mcpToolUiCspSchema in mcp-apps.
    csp: z
      .object({
        connectDomains: z.array(z.string()).optional(),
        resourceDomains: z.array(z.string()).optional(),
        frameDomains: z.array(z.string()).optional(),
        baseUriDomains: z.array(z.string()).optional(),
      })
      .strict()
      .optional(),
    // Resource-level `_meta["zcode/csp"]` relaxations; keep in sync with mcpAppCspRelaxationsSchema in mcp-apps.
    cspRelaxations: z
      .object({ unsafeEval: z.boolean().optional(), wasmUnsafeEval: z.boolean().optional() })
      .strict()
      .optional(),
    // Resource-level `_meta.ui.permissions` (the four standard keys); keep in sync with MCP_APPS_RESOURCE_PERMISSIONS in mcp-apps.
    permissions: z
      .array(z.enum(["camera", "microphone", "geolocation", "clipboardWrite"]))
      .optional(),
    prefersBorder: z.boolean().optional(),
    // Resource-level size hints, copied unchanged by main into the handle’s resourceMeta. This is a strict schema; changes to PluginSandboxRegisterRequestPayload must be reflected here.
    heightHint: z.number().int().positive().optional(),
    minFrameHeight: z.number().int().positive().optional(),
    showInline: z.boolean().optional(),
  })
  .strict()
  .refine(
    (value) =>
      value.contentKind === "gen-ui"
        ? !value.pluginId && !value.serverName && !value.permissions?.length
        : Boolean(value.pluginId && value.serverName),
    "Invalid sandbox provenance",
  );

export const networkObservationSchema = z.object({
  transport: z.enum(["http", "websocket", "rpc"]),
  interface: z.string(),
  durationMs: z.number(),
  ok: z.boolean(),
  statusCode: z.number().optional(),
  errorKind: z.string().optional(),
  attempt: z.number().int().positive().optional(),
  dnsMs: z.number().optional(),
  tcpMs: z.number().optional(),
  tlsMs: z.number().optional(),
  ttfbMs: z.number().optional(),
  downloadMs: z.number().optional(),
});

export const hostNetworkTelemetryBatchResponseSchema = z.object({
  type: z.literal("network-telemetry-batch"),
  observations: z.array(networkObservationSchema).max(500),
});

export const hostProviderProvisioningSourceChangedResponseSchema = z
  .object({
    type: z.literal("provider-provisioning-source-changed"),
    trigger: providerProvisioningTriggerSchema.exclude(["environment-online"]),
  })
  .strict();

export const hostProviderProvisioningExecutionResultResponseSchema = z
  .object({
    type: z.literal("provider-provisioning-execution-result"),
    requestId: nonEmptyStringSchema,
    environmentKey: nonEmptyStringSchema,
    status: z.enum(["applied", "already-applied", "unsupported", "failed", "rollback_failed"]),
    error: z.string().optional(),
    errorCode: providerProvisioningErrorCodeSchema.optional(),
  })
  .strict();

export const hostResourceUsageProcessSchema = z
  .object({
    pid: z.number().int().positive(),
    name: nonEmptyStringSchema,
    category: z.enum(["base", "builtin-plugin", "community-plugin"]),
    groupKey: nonEmptyStringSchema,
    groupLabel: nonEmptyStringSchema,
    cpuPercent: z.number().finite().nonnegative(),
    memoryBytes: z.number().finite().nonnegative(),
  })
  .strict();

export const hostResourceUsageSnapshotResultResponseSchema = z
  .object({
    type: z.literal("resource-usage-snapshot-result"),
    requestId: nonEmptyStringSchema,
    sampledAt: z.number().int().nonnegative(),
    processes: z.array(hostResourceUsageProcessSchema).max(10_000),
  })
  .strict();
export type HostResourceUsageSnapshotResultResponse = z.infer<
  typeof hostResourceUsageSnapshotResultResponseSchema
>;

export const hostResponseMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("network-capture-batch"), batch: networkCaptureBatchSchema }).strict(),
  z
    .object({ type: z.literal("database-startup-state"), state: databaseStartupStateSchema })
    .strict(),
  hostResourceUsageSnapshotResultResponseSchema,
  hostRemoteWorkspaceConnectionLogResponseSchema,
  hostRemoteWorkspaceConnectedResponseSchema,
  hostRemoteWorkspaceConnectFailedResponseSchema,
  hostRemoteWorkspaceClosedResponseSchema,
  hostLogResponseSchema,
  hostAgentProcessSpawnedResponseSchema,
  hostAgentProcessReadyResponseSchema,
  hostAgentProcessExitedResponseSchema,
  hostAgentProcessErrorResponseSchema,
  hostAgentProcessExceptionResponseSchema,
  hostAgentResourceSampleResponseSchema,
  hostResourceSampleResponseSchema,
  hostMcpTelemetryResponseSchema,
  hostMcpResourceSamplesResponseSchema,
  hostToolExecResourceResponseSchema,
  hostSessionCreateTelemetryResponseSchema,
  hostAgentRunningTaskCountChangedResponseSchema,
  hostWorkspaceRunningTaskCountChangedResponseSchema,
  hostCuaOperationStateResponseSchema,
  hostBroadcastEnvelopeSchema,
  hostBroadcastClaimRequestResponseSchema,
  hostBroadcastClaimCommitResponseSchema,
  hostBroadcastClaimReleaseResponseSchema,
  hostTaskRealtimePublishResponseSchema,
  hostTaskStreamOpPublishResponseSchema,
  hostTaskRunLeaseAcquireResponseSchema,
  hostTaskRunLeaseReleaseResponseSchema,
  hostTaskOwnerCommandRequestResponseSchema,
  hostTaskOwnerCommandResultResponseSchema,
  hostBotRemoteWorkspaceReconnectRequestResponseSchema,
  hostBotRemoteWorkspaceConnectionStatusRequestResponseSchema,
  hostBotRemoteWorkspaceRuntimePortRequestResponseSchema,
  hostSessionMessageSendRequestedResponseSchema,
  hostSessionRouteAnnounceResponseSchema,
  hostSessionMessageDeliverResultResponseSchema,
  hostFeedbackLogArchiveRequestResponseSchema,
  hostBrowserExecuteRequestResponseSchema,
  hostLocalMediaPreviewPathAuthorizeRequestResponseSchema,
  hostPluginSandboxRegisterRequestResponseSchema,
  hostNetworkTelemetryBatchResponseSchema,
  hostProviderProvisioningSourceChangedResponseSchema,
  hostProviderProvisioningExecutionResultResponseSchema,
  hostCronRunResultResponseSchema,
  hostOffPeakRunResultResponseSchema,
  hostCronSchedulerWakeRequestResponseSchema,
  hostOffPeakSchedulerWakeRequestResponseSchema,
]);

export const zcodeTaskPersistStatusSchema = z.enum(["running", "completed", "error"]);

export const zcodePromptImageAttachmentSchema = z.object({
  kind: z.literal("image"),
  filename: z.string(),
  mimeType: z.string(),
  sizeBytes: z.number().int().nonnegative().optional(),
  dataBase64: z.string().optional(),
  localPath: z.string().optional(),
});

// After video was added to the TypeScript attachment union, the hand-written persistence runtime schema
// was not updated, so session recovery rejected user messages containing video. Keep these fields
// consistent with the inline/local reference semantics used for images.
export const zcodePromptVideoAttachmentSchema = z.object({
  kind: z.literal("video"),
  filename: z.string(),
  mimeType: z.string(),
  sizeBytes: z.number().int().nonnegative().optional(),
  dataBase64: z.string().optional(),
  localPath: z.string().optional(),
});

export const zcodePromptPdfAttachmentSchema = z.object({
  kind: z.literal("pdf"),
  filename: z.string(),
  mimeType: z.string(),
  sizeBytes: z.number().int().nonnegative().optional(),
  dataBase64: z.string().optional(),
  localPath: z.string().optional(),
});

export const zcodePromptFileAttachmentSchema = z.object({
  kind: z.literal("file"),
  filename: z.string(),
  mimeType: z.string(),
  sizeBytes: z.number().int().nonnegative(),
  dataBase64: z.string().optional(),
  textContent: z.string().optional(),
  localPath: z.string().optional(),
});

export const zcodePromptAttachmentSchema = z.discriminatedUnion("kind", [
  zcodePromptImageAttachmentSchema,
  zcodePromptVideoAttachmentSchema,
  zcodePromptPdfAttachmentSchema,
  zcodePromptFileAttachmentSchema,
]);

export const zcodePersistedToolCallSchema = z.object({
  toolName: z.string().optional(),
  title: z.string().optional(),
  kind: z.string().optional(),
  status: z.enum(["completed", "failed", "denied", "stopped"]).optional(),
  input: z.unknown(),
  output: z.unknown().optional(),
  error: z.string().optional(),
  raw: z.unknown().optional(),
  snapshotRefs: z
    .array(
      z.object({
        field: z.enum(["input", "output", "raw"]),
        refId: z.string(),
        hash: z.string(),
        fullBytes: z.number().int().nonnegative(),
        previewBytes: z.number().int().nonnegative(),
      }),
    )
    .optional(),
});

const zcodePersistedMessagePartSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("content"), content: z.string() }),
  z.object({ type: z.literal("thought"), content: z.string() }),
  z.object({
    type: z.literal("tool-call"),
    toolIndex: z.number().int().nonnegative(),
  }),
]);

export const zcodePersistedMessageSchema = z.object({
  id: z.string().optional(),
  role: z.enum(["user", "assistant"]),
  content: z.string(),
  timestamp: z.number().int().nonnegative(),
  model: z.string().optional(),
  characterCount: z.number().int().nonnegative().optional(),
  // Assistant historical duration is already persisted by the service layer as durationMs, but the
  // validation schema was not updated. saveTask/getTaskSnapshot silently stripped it during parsing,
  // so after a new message ended the UI could show only "Worked". Include the field to preserve the
  // persisted value.
  durationMs: z.number().int().nonnegative().optional(),
  interrupted: z.boolean().optional(),
  feedback: z.enum(["like", "dislike"]).optional(),
  attachments: z.array(zcodePromptAttachmentSchema).optional(),
  tools: z.array(zcodePersistedToolCallSchema).optional(),
  thought: z.string().optional(),
  parts: z.array(zcodePersistedMessagePartSchema).optional(),
  checkpointState: z.enum(["partial"]).optional(),
  checkpointReason: z.enum(["tool_completed", "part_boundary", "periodic"]).optional(),
  checkpointUpdatedAt: z.number().int().nonnegative().optional(),
  turnIndex: z.number().int().nonnegative().optional(),
  // On-demand snapshot loading uses bodyRefs (content/thought -> refId) to locate full content. If the
  // schema omits this field, Zod silently strips it while parsing the session file and the "load full
  // content" feature stops working.
  bodyRefs: z
    .array(
      z.object({
        field: z.enum(["content", "thought"]),
        refId: z.string(),
        hash: z.string(),
        fullBytes: z.number().int().nonnegative(),
        previewBytes: z.number().int().nonnegative(),
      }),
    )
    .optional(),
  toolSlice: z
    .object({
      persistedMessageIndex: z.number().int().nonnegative(),
      totalTools: z.number().int().nonnegative(),
      startToolIndex: z.number().int().nonnegative(),
      endToolIndexExclusive: z.number().int().nonnegative(),
    })
    .optional(),
});

export const zcodeTaskGoalStatusSchema = z.enum(["active", "paused", "budget_limited", "complete"]);

export const zcodeTaskTargetChangedActionSchema = z.enum([
  "set",
  "status_updated",
  "cleared",
  "usage_accounted",
  "run_started",
  "run_finished",
  "summary_updated",
]);

export const zcodeTaskTargetChangedSourceSchema = z.enum(["command", "tool", "runtime"]);

export const zcodeTaskGoalSchema = z.object({
  sessionID: nonEmptyStringSchema,
  targetID: nonEmptyStringSchema,
  objective: nonEmptyStringSchema,
  // Historical /goal tasks created before 2.15.0 have no summaryTitle. Default it to null when reading
  // old task-index data, or the runtime schema will reject the entire task list.
  summaryTitle: z.string().min(1).nullable().default(null),
  status: zcodeTaskGoalStatusSchema,
  tokenBudget: z.number().int().positive().nullable(),
  tokensUsed: z.number().int().nonnegative(),
  timeUsedSeconds: z.number().int().nonnegative(),
  activeInputId: nonEmptyStringSchema.nullable().optional(),
  activeRunStartedAtMs: z.number().int().nonnegative().nullable().optional(),
  activeRunLastSeenAtMs: z.number().int().nonnegative().nullable().optional(),
  time: z.object({
    created: z.number().int().nonnegative(),
    updated: z.number().int().nonnegative(),
  }),
});

export const zcodeTaskGoalChangedPatchSchema = z.object({
  action: zcodeTaskTargetChangedActionSchema,
  source: zcodeTaskTargetChangedSourceSchema,
  target: zcodeTaskGoalSchema.nullable(),
  previousTarget: zcodeTaskGoalSchema.nullable().optional(),
});

export const zcodeTaskTargetStatusSchema = zcodeTaskGoalStatusSchema;
export const zcodeTaskTargetSchema = zcodeTaskGoalSchema;
export const zcodeTaskTargetChangedPatchSchema = zcodeTaskGoalChangedPatchSchema;

export const zcodeTaskMetaSchema = z.object({
  taskId: nonEmptyStringSchema,
  traceId: nonEmptyStringSchema,
  title: z.string(),
  titleOverridden: z.boolean().optional(),
  workspacePath: nonEmptyStringSchema,
  workspaceIdentity: nonEmptyStringSchema.optional(),
  workspacePurpose: z.enum(["project", "conversation"]).optional(),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
  mode: zcodeTaskModeSchema,
  model: z.string().optional(),
  thoughtLevel: nonEmptyStringSchema.optional(),
  runtimeEpoch: z.number().int().nonnegative().optional(),
  // meta is parsed directly from tasks-index/legacy session files; normalize historical provider values to glm here.
  provider: legacyZCodeProviderSchema.optional(),
  migrationSource: zcodeTaskMigrationSourceSchema.optional(),
  forkedFromTaskId: nonEmptyStringSchema.optional(),
  // Cron automation identity is persisted with meta_json as the single source of truth and projected to
  // the tasks table's cron_automation_id index column on write, allowing sessions to be looked up by
  // automation. runId belongs to automation_runs/delivery metadata, not the task table.
  cronAutomationId: nonEmptyStringSchema.optional(),
  // Off-peak identity uses the same persistence strategy as cron: meta_json is the single source of
  // truth, with an off_peak_task_id index projection column in the tasks table for fallback/lookups.
  offPeakTaskId: nonEmptyStringSchema.optional(),
  unreadAt: z.number().int().nonnegative().optional(),
  status: zcodeTaskPersistStatusSchema.optional(),
  lastError: z
    .object({
      code: z.string().optional(),
      detail: z.string().optional(),
      message: z.string().min(1),
      traceId: nonEmptyStringSchema.optional(),
      taskId: nonEmptyStringSchema.optional(),
      attribution: errorAttributionSchema.optional(),
    })
    .optional(),
  repairState: z
    .object({
      claudeNativeSnapshotAssistantContentVersion: z.number().int().nonnegative().optional(),
      codexNativeSnapshotSubagentToolsVersion: z.number().int().nonnegative().optional(),
    })
    .optional(),
  changeSummary: z
    .object({
      fileCount: z.number().int().nonnegative(),
      added: z.number().int().nonnegative(),
      removed: z.number().int().nonnegative(),
      files: z.array(
        z.object({
          path: z.string(),
          added: z.number().int().nonnegative(),
          removed: z.number().int().nonnegative(),
          writeCount: z.number().int().positive(),
          lastTurnIndex: z.number().int().nonnegative(),
        }),
      ),
    })
    .optional(),
  target: zcodeTaskGoalSchema.nullable().optional(),
});

export const zcodeTaskSessionBindingStateSchema = z.enum([
  "idle",
  "syncing",
  "ready",
  "stale",
  "failed",
]);

export const zcodeTaskSessionBindingSchema = z.object({
  // Binding state is projected by services from persisted data; normalize historical provider values left by old bindings to glm here.
  provider: legacyZCodeProviderSchema,
  sessionId: nonEmptyStringSchema,
  // The binding anchor must support -1 for an empty task, so do not apply nonnegative here.
  lastSyncedTurnIndex: z.number().int(),
  state: zcodeTaskSessionBindingStateSchema,
});

export const zcodeTaskIndexEntrySchema = z.object({
  workspaceHash: nonEmptyStringSchema,
  taskId: nonEmptyStringSchema,
});

export const zcodePinnedTasksFileSchema = z.object({
  version: z.literal("1"),
  tasks: z.array(zcodeTaskIndexEntrySchema),
});

const zcodePersistedFileSnapshotSchema = z.object({
  path: z.string(),
  beforeContent: z.string().nullable(),
  afterContent: z.string(),
  writeCount: z.number().int().positive(),
  contentRefs: z
    .array(
      z.object({
        field: z.enum(["beforeContent", "afterContent"]),
        refId: z.string(),
        hash: z.string(),
        fullBytes: z.number().int().nonnegative(),
        previewBytes: z.number().int().nonnegative(),
      }),
    )
    .optional(),
});

const zcodePersistedFileChangeSchema = z.object({
  turnIndex: z.number().int().nonnegative(),
  snapshots: z.array(zcodePersistedFileSnapshotSchema),
  fileState: z.enum(["applied", "reverted"]).optional(),
});

const zcodePersistedTurnCheckpointSchema = z.object({
  turnIndex: z.number().int().nonnegative(),
  baseFileCheckpointId: nonEmptyStringSchema,
  resultFileCheckpointId: nonEmptyStringSchema.optional(),
});

export const zcodeSessionFileSchema = z.object({
  meta: zcodeTaskMetaSchema,
  messages: z.array(zcodePersistedMessageSchema),
  fileChanges: z.array(zcodePersistedFileChangeSchema).optional(),
  turnCheckpoints: z.array(zcodePersistedTurnCheckpointSchema).optional(),
});

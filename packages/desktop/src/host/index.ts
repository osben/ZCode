import { normalizeRemoteConnectionError, sanitizeRemoteConnectionLog } from "@zcode/shared";
import { join } from "node:path";
/* eslint-disable max-lines -- Host entry point wires local and remote services together; the exit guard must bridge host reporting in this same place. */
/* eslint-disable max-lines -- The host process entry keeps local/remote initialization and resource teardown together; the realtime bridge stays in this same file for now. */
/**
 * Host Process entry: one independent host process per window
 *
 * The Renderer and the phone of the same window both attach to this Host:
 *   Renderer / Mobile ←MessagePort→ Window Host
 *                                      ├─ local services
 *                                      └─ remote connection registry
 *
 * Startup flow:
 * 1. The main process creates this process through Electron `utilityProcess.fork()`
 * 2. The main process sends init-local only once to initialize the window Host
 * 3. Later remote connect / scoped attachments are handled by the same Host
 */
import { createHostDatabaseStartup } from "./database-startup/hostDatabaseStartup.js";
import { isOffPeakTerminalStatus } from "@zcode/shared";
import { createHostNetworkCapture } from "./hostNetworkCapture.js";
import { randomUUID } from "node:crypto";
import { createPluginSandboxRegistrationBridge } from "./pluginSandbox/index.js";
import { createWindowTopicResourceRelay } from "./windowTopicResourceRelay.js";
import {
  MessagePortProtocol,
  ChannelServer,
  type IDisposable,
  type IChannelServer,
  LoggingChannelServer,
  NetworkTelemetryChannelServer,
} from "@zcode/rpc";
import { registerHostNetworkTelemetry, stopHostNetworkTelemetry } from "./hostNetworkTelemetry.js";
import { registerHostServiceResourceTelemetry } from "./hostServiceResourceTelemetry.js";
import { resolveResourceTelemetryEnvironmentKey } from "./hostResourceTelemetryEnvironment.js";
import { reportHostSessionCreate } from "./hostSessionCreateTelemetry.js";
import { createBrowserControlMainBridge } from "./browserControlMainBridge.js";
import { materializeBrowserRecordingArtifact } from "./browserRecordingArtifactMaterializer.js";
import {
  ServiceCollection,
  IBotsService,
  ICredentialService,
  IFileService,
  IClientConfigService,
  IMediaPreviewService,
  IOffPeakTaskService,
  IRemoteProjectService,
  type RemoteProjectHost,
  IProjectService,
  ITaskGroupService,
  IQuickPromptService,
  IBroadcastService,
  IModelSelectionService,
  ISettingService,
  ISourceServerManagementService,
  ITerminalService,
  IDeviceSyncStateService,
  IProviderProvisioningStatusService,
  IWindowControllerService,
  IConversationShareService,
  IPromptAttachmentTransferService,
  IZCodeAgentService,
  IZCodeTaskService,
  IZCodeSessionService,
  ICuaPipSessionService,
  createZCodeAgentConnectionScope,
  type ZCodeAgentV4ClientMode,
  collectServiceMemoryDiagnostics,
  createWebRemoteProjectTreeActivityBridge,
} from "@zcode/services";
import {
  createLocalServices,
  createProjectWorkspaceNavigation,
  createRemoteProjectConnectionAdmission,
  remoteProjectHostIdForProfile,
  remoteProjectHostIdForTarget,
  prepareRemoteServerConnection,
  bindRemoteProjectIdentities,
  createRemoteIdentityRegistrationCache,
  getOffPeakRequestAuthBuilder,
  disposeServiceResources,
  disposeServiceResourcesAndWait,
  AutomationRepo,
  OffPeakTaskRepo,
  OffPeakTaskService,
  createServiceLogger,
  buildTaskChangeSummary,
  createHostApiNetworkTransport,
  createSettingServiceWithMigrations,
  createDeviceSyncStateService,
  createHostProviderProvisioningStatus,
  getAppConfigDir,
  OffPeakModelUnavailableError,
  OffPeakPermanentDispatchError,
  type BotProjectConnection,
  type HostApiNetworkTransport,
  type OffPeakRequestAuthBuilder,
} from "@zcode/services/node";
import { createHostResourceUsageResponder } from "./hostResourceUsage.js";
import {
  assertBoundSessionDispatchable,
  resolveOffPeakDispatchKind,
} from "./offPeakDispatchPlan.js";
import {
  HostMessageTypes,
  HostResponseTypes,
  formatLogPrefix,
  formatZCodeHostProcessName,
  formatZodError,
  buildRemoteWorkspaceIdentity,
  buildServerRemoteWorkspaceIdentity,
  remoteHostIdFromWorkspaceIdentity,
  buildRemoteEnvironmentKey,
  isRemoteWorkspaceIdentity,
  parseRemoteWorkspaceIdentity,
  buildRemoteHostWorkspaceIdentity,
  resolveWorkspaceKey,
  REMOTE_BIND_CANCELED_ERROR_CODE,
  REMOTE_WORKSPACE_BIND_SESSION_MISSING_ERROR_CODE,
  formatModelPickerValue,
  type ZCodePromptAttachment,
  type ZCodeStreamEvent,
  type ZCodeTaskMeta,
  type TaskStreamMirrorableEvent,
  type TraceId,
  type ZCodeTaskMode,
  type WindowHostAttachmentScope,
  type SourceServerArtifactPolicy,
  type ZCodeAutomation,
  type ZCodeAutomationRun,
  type ZCodeAutomationRunOutcome,
  type ModelSelection,
} from "@zcode/shared";
import {
  parseHostIncomingMessageEvent,
  rejectUnavailableAttachedServicePort,
} from "./hostMessagePortGuard.js";
// Remote backend modules are loaded lazily: the ssh2 CJS dependency chain (asn1, etc.) breaks its paths after asar packaging,
// so a static import would also crash the local-mode host process.
// Switched to a dynamic import, loaded only in remote mode.
import type { IRemoteBackend } from "@zcode/server/remote";
import type { Locale, RemoteTarget } from "@zcode/shared";
import { wrapElectronPort } from "./electronPort.js";
import { createTaskRealtimeBridgeForHostInit } from "./taskRealtimeBridge.js";
import { resolveRpcLogLevel } from "./rpcLogLevel.js";
import { createHostWorkspaceTaskTracker } from "./hostWorkspaceTaskTracker.js";
import {
  createRemoteMediaPreviewProxy,
  type RemoteMediaPreviewProxy,
} from "./remoteMediaPreviewProxy.js";
import { watchCronRunBotDelivery } from "./cronBotDelivery.js";
import { createHostRemoteWorkspaceProxyState } from "./hostRemoteWorkspaceProxyState.js";
import {
  createServerRemoteWorkspaceServiceCollection,
  resolveServerProjectService,
} from "./remoteWorkspaceServiceCollection.js";
import { getRemoteProviderProvisioningExecutor } from "./remoteProviderProvisioningService.js";
import {
  createSourceSettingsServiceCollection,
  shouldDetachSourceSettingsAttachment,
} from "./sourceSettingsServiceCollection.js";
import { shouldReportHostConsoleError, stringifyHostLogArg } from "./hostLog.js";
import { flushHostE2ECoverage } from "./e2eCoverage.js";
import { runHostShutdownPhases, type HostShutdownResult } from "./hostShutdownPhases.js";
import { initializeHostApiNetworkTransportOwner } from "./hostInitialization.js";
import { createHostUncaughtExceptionHandler } from "./hostUncaughtExceptionGuard.js";
import {
  recordCronRunOutcomeBestEffort,
  startManualClaimHeartbeat,
  settleCronRunTerminalOutcome,
  settleManualDispatchFailureBestEffort,
} from "./cronRunLifecycle.js";
import { connectServerRemote, type ServerRemoteConnection } from "./serverRemoteConnection.js";
import { bindBotGroupTaskScope } from "./botGroupTaskScope.js";
import {
  createWindowHostAttachmentFlowForwarder,
  createWindowHostAttachmentRegistry,
  type WindowHostAttachmentDisposeReason,
} from "./windowHostAttachmentRegistry.js";
import {
  exposeWindowHostAttachmentServices,
  createWindowHostTerminalOwners,
  createTerminalScope,
} from "./windowHostAttachmentRpcPolicy.js";
import { scopeConversationShareServiceForAttachment } from "./conversationShareAttachmentService.js";
import {
  createWindowRemoteConnectionRegistry,
  type WindowRemoteConnectionCloseEvent,
  type WindowRemoteConnectionHandle,
} from "./windowRemoteConnectionRegistry.js";
import { pushDynamicWorkflowUserModeToRemoteHosts } from "./remoteDynamicWorkflowUserMode.js";
import { connectDesktopSourceServer } from "./connectDesktopSourceServer.js";
import { prepareRemoteWorkspaceIdentity } from "./remoteWorkspacePreparation.js";
import { createWindowHostControllerRuntime } from "@zcode/services/window-controller";
import { resolveBotRemoteWorkspace } from "./botRemoteWorkspaceResolver.js";
import { SourceServerDirectory } from "./sourceServerDirectory.js";
import { connectSourceServerTarget } from "./connectSourceServerTarget.js";
import {
  SourceServerConnectionManager,
  SourceServerInstallRequiredError,
  SourceServerUpgradeRequiredError,
  readHostKeyProfileId,
} from "./sourceServerConnectionManager.js";
import { createSourceServerRecoveryCloseEvent } from "./sourceServerRecoveryPolicy.js";
import { runStartupReconnectBatch } from "./sourceServerStartupReconnect.js";
import {
  createSourceServerManagementService,
  type SourceServerManagementService,
} from "./sourceServerManagementService.js";
import { resolveSourceServerReleaseAsset } from "./sourceServerReleaseResolver.js";
import { resolveAutomationSubmissionModelSelection } from "./automationModelSelection.js";
import { createRemoteConnectionProgressContext } from "@zcode/server/remote/remoteConnectionProgressContext.js";
import {
  createRemotePromptAttachmentTransferService,
  type RemotePromptAttachmentTransferService,
} from "./promptAttachmentTransferService.js";
import { startHostSelfResourceTelemetry } from "./hostSelfResourceTelemetry.js";
type HostRemoteConnection = ServerRemoteConnection;
interface HostRemoteConnectionCapabilities {
  promptAttachmentTransferFactory?: (
    scope: Extract<WindowHostAttachmentScope, { kind: "remote" }>,
  ) => RemotePromptAttachmentTransferService;
  browserRecordingUploader?: Pick<IRemoteBackend, "upload">;
  remoteMediaPreviewFactory?: (
    scope: Extract<WindowHostAttachmentScope, { kind: "remote" }>,
  ) => RemoteMediaPreviewProxy;
  sourceServerId?: string;
  persistentSourceConnection?: boolean;
  /** Identity of the underlying service instance; creating a logical wrapper does not mean the physical connection was replaced. */
  physicalOwner?: () => object;
  profileId?: string;
  recordWorkspaceOpen?: (input: {
    workspacePath: string;
    workspaceIdentity: string;
    workspacePurpose?: import("@zcode/shared").WorkspacePurpose;
    legacyWorkspaceIdentity?: string;
    signal?: AbortSignal;
  }) => Promise<void>;
  bindWorkspaceIdentity?: (input: {
    workspacePath: string;
    stableWorkspaceIdentity: string;
    legacyRouteHint?: string;
    signal?: AbortSignal;
  }) => Promise<void>;
}

let activeRemoteMediaRequests = 0;
const hostRemoteMediaRequestLimiter = {
  tryAcquire: () => {
    if (activeRemoteMediaRequests >= 4) return false;
    activeRemoteMediaRequests += 1;
    return true;
  },
  release: () => {
    activeRemoteMediaRequests = Math.max(0, activeRemoteMediaRequests - 1);
  },
  getState: () => ({ active: activeRemoteMediaRequests, limit: 4 }),
};
const remoteMediaRangePreviewEnabled =
  process.env["ZCODE_REMOTE_MEDIA_RANGE_PREVIEW_ENABLED"] !== "0";

type RemoteAssetDirs = import("./windowRemoteConnectionRegistry.js").WindowRemoteAssetDirs;

const { parentPort } = process;
const hostNetworkCapture = createHostNetworkCapture(parentPort);

interface PendingOpenWorkspaceInventoryRequest {
  resolve: (inventory: { available: boolean; paths: string[] }) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

const pendingOpenWorkspaceInventoryRequests = new Map<
  string,
  PendingOpenWorkspaceInventoryRequest
>();
let nextOpenWorkspaceInventoryRequestSeq = 0;
function requestOpenWorkspaceInventory(): Promise<{
  available: boolean;
  paths: string[];
}> {
  if (!parentPort) return Promise.reject(new Error("parentPort unavailable"));
  const requestId = `open-workspace-inventory-${Date.now()}-${nextOpenWorkspaceInventoryRequestSeq++}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingOpenWorkspaceInventoryRequests.delete(requestId);
      reject(new Error("Open workspace inventory request timed out."));
    }, 5000);
    pendingOpenWorkspaceInventoryRequests.set(requestId, { resolve, reject, timer });
    try {
      parentPort.postMessage({ type: HostResponseTypes.OpenWorkspaceInventoryRequest, requestId });
    } catch (error) {
      clearTimeout(timer);
      pendingOpenWorkspaceInventoryRequests.delete(requestId);
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

// Process-list readability: when utilityProcess launches the host, the shell is still an Electron Helper.
// Based on the window label passed by main, add a stable zcode-* title so the system process list can be filtered.
process.title = formatZCodeHostProcessName(process.env["ZCODE_PROCESS_LABEL"]);

type HostLogLevel = "info" | "warn" | "error";

interface PendingFeedbackLogArchiveRequest {
  resolve: (archive: { path: string; size: number }) => void;
  reject: (error: Error) => void;
  onProgress?: (event: { processedBytes: number; totalBytes: number }) => void;
}

interface PendingLocalMediaPreviewPathAuthorization {
  resolve: (path: string) => void;
  reject: (error: Error) => void;
}

const pendingFeedbackLogArchiveRequests = new Map<string, PendingFeedbackLogArchiveRequest>();
let nextFeedbackLogArchiveRequestSeq = 0;
const pendingLocalMediaPreviewPathAuthorizations = new Map<
  string,
  PendingLocalMediaPreviewPathAuthorization
>();

function authorizeLocalMediaPreviewPath(path: string): Promise<string> {
  if (!parentPort) {
    return Promise.reject(new Error("parentPort unavailable"));
  }
  const requestId = randomUUID();
  return new Promise<string>((resolve, reject) => {
    pendingLocalMediaPreviewPathAuthorizations.set(requestId, { resolve, reject });
    try {
      parentPort.postMessage({
        type: HostResponseTypes.LocalMediaPreviewPathAuthorizeRequest,
        requestId,
        path,
      });
    } catch (error) {
      pendingLocalMediaPreviewPathAuthorizations.delete(requestId);
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

// Provisioning lane used by the Data Sync page's "Model providers" category to read and retry the Main coordinator (local Host only).
const hostProviderProvisioningStatus = createHostProviderProvisioningStatus((message) => {
  if (!parentPort) throw new Error("parentPort unavailable");
  parentPort.postMessage(message);
});

const pluginSandboxRegistrationBridge = createPluginSandboxRegistrationBridge({
  send: (message) => {
    if (!parentPort) throw new Error("parentPort unavailable");
    parentPort.postMessage(message);
  },
});

// browser-use host<->main bridge: forwards agent browser commands to main through parentPort (WebContentsView+CDP).
// If parentPort is missing (should not happen in the host process), postToMain throws and the bridge returns backend_unavailable itself.
let browserBackendIdentity: { id: string; generation: number } | undefined;
const browserControlMainBridge = createBrowserControlMainBridge({
  getBackendIdentity: () => browserBackendIdentity,
  postToMain: (message) => {
    if (!parentPort) {
      throw new Error("parentPort unavailable");
    }
    parentPort.postMessage(message);
  },
  materializeRecording: (input) => {
    let remoteBackend: Pick<IRemoteBackend, "upload"> | undefined;
    if (input.remoteSessionId) {
      const workspaceIdentity = input.workspaceIdentity;
      if (!workspaceIdentity?.trim()) {
        throw new Error("remote Browser recording materialization requires workspaceIdentity");
      }
      // The Window Host refactor lets one process hold several remote connections at once; a process-level
      // remoteConnection would mix up sessions. The uploader must be taken from the registry's authoritative entry using the full scope.
      remoteBackend = windowRemoteConnectionRegistry.resolveScopedCapabilities({
        kind: "remote",
        remoteSessionId: input.remoteSessionId,
        workspacePath: input.workspacePath,
        workspaceIdentity,
      })?.browserRecordingUploader;
      if (!remoteBackend) {
        throw new Error(
          "Source Server browser recording transfer requires the remote resource transaction path",
        );
      }
    }
    return materializeBrowserRecordingArtifact({
      ...input,
      ...(remoteBackend ? { remoteBackend } : {}),
    });
  },
});

function reportHostLog(level: HostLogLevel, args: unknown[]): void {
  if (!parentPort) {
    return;
  }

  try {
    parentPort.postMessage({
      type: HostResponseTypes.Log,
      level,
      source: "host",
      message: args.map((arg) => stringifyHostLogArg(arg)).join(" "),
    });
  } catch {
    // A failure to report logs must not affect the main host flow.
  }
}

const rawConsole = {
  log: console.log.bind(console),
  warn: console.warn.bind(console),
  error: console.error.bind(console),
};

const remoteConnectionProgressContext = createRemoteConnectionProgressContext({
  emit: ({ requestId, level, args }) => {
    if (!parentPort) {
      return;
    }
    try {
      parentPort.postMessage({
        type: HostResponseTypes.RemoteWorkspaceConnectionLog,
        requestId,
        level,
        message: args.map((arg) => stringifyHostLogArg(arg)).join(" "),
      });
    } catch {
      // A failure to report connection progress must not interrupt the real SSH/WSL/Docker connection flow.
    }
  },
});

function writeHostLog(level: HostLogLevel, ...args: unknown[]): void {
  const prefix = formatLogPrefix("zcode-host", process.pid);
  const consoleFn =
    level === "error" ? rawConsole.error : level === "warn" ? rawConsole.warn : rawConsole.log;
  consoleFn(prefix, ...args);
  reportHostLog(level, [prefix, ...args]);
}

function createFullFeedbackLogArchiveViaMain(
  sourceDir: string,
  options?: {
    onProgress?: (event: { processedBytes: number; totalBytes: number }) => void;
  },
): Promise<{ path: string; size: number }> {
  const requestId = `feedback-log-archive-${Date.now()}-${nextFeedbackLogArchiveRequestSeq++}`;
  options?.onProgress?.({ processedBytes: 0, totalBytes: 0 });

  return new Promise((resolve, reject) => {
    pendingFeedbackLogArchiveRequests.set(requestId, {
      resolve,
      reject,
      onProgress: options?.onProgress,
    });
    // Feedback used to go through compactLogArchive's full fallback inside the host service,
    // so its collection scope differed from "Export logs" and lacked zcode-cli logs, rollout/debug, and export-path redaction.
    // The full log bundle is now delegated to the same export-logs logic as main; the host only takes the zip path and continues the upload.
    try {
      parentPort.postMessage({
        type: HostResponseTypes.FeedbackLogArchiveRequest,
        requestId,
        sourceDir,
      });
    } catch (error) {
      pendingFeedbackLogArchiveRequests.delete(requestId);
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

const logger = {
  info: (...args: unknown[]) => writeHostLog("info", ...args),
  warn: (...args: unknown[]) => writeHostLog("warn", ...args),
  error: (...args: unknown[]) => writeHostLog("error", ...args),
};

const cronAutomationRepo = new AutomationRepo();
const cronRunSubscriptions = new Map<string, { dispose(): void }>();

// ---- Off-peak task dispatch: an independent pipeline running in parallel with cron (tables/messages/constants are not shared) ----
const offPeakTaskRepo = new OffPeakTaskRepo();
const offPeakRunSubscriptions = new Map<string, { dispose(): void }>();
/**
 * Continuation prompt (the implementation of "decided at implementation time"): after the 3h time box expires or the app restarts, resume the same
 * session and send again. The original prompt is not re-sent (that would make the model start over); instead it directs the model to pick up the unfinished work.
 */
const OFF_PEAK_RESUME_PROMPT =
  "Continue the previous task from where it left off. The run was interrupted " +
  "(app restart or execution window expired). Do not start over; review what has " +
  "already been done and complete the remaining work.";

// ---- Off-peak runtime assembly (server client + in-process mock gateway + orchestration service; owned by the host domain) ----
// ⚠ Multiple windows = multiple hosts, each running its own sync polling (batch APIs are idempotent and write the same data to the same DB; duplicates only cost extra requests);
// the mock gateway uses a fixed port with a single instance to share ticket state. If polling from multiple windows becomes too costly, add cross-host leader election.
interface OffPeakRuntime {
  service: OffPeakTaskService;
  /** Per-request auth is built at dispatch time from this ticket segment; static model facts come from the CLI Built-in Config. */
  buildRequestAuth: OffPeakRequestAuthBuilder;
  validateSelection: (selection: {
    providerId: string;
    modelId: string;
    options?: { reasoningLevel?: string };
  }) => Promise<boolean>;
}
let offPeakRuntime: OffPeakRuntime | null = null;

async function ensureOffPeakRuntime(): Promise<OffPeakRuntime | null> {
  if (offPeakRuntime) return offPeakRuntime;
  const services = activeServices;
  if (!services) return null;
  const service = services.getOptional(IOffPeakTaskService);
  const buildRequestAuth = getOffPeakRequestAuthBuilder(services);
  if (!service || !buildRequestAuth) {
    logger.warn("off-peak runtime unavailable: missing host services");
    return null;
  }
  offPeakRuntime = {
    service: service as OffPeakTaskService,
    buildRequestAuth,
    validateSelection: (selection) =>
      (service as OffPeakTaskService).validateDispatchModelSelection(selection),
  };
  logger.info("off-peak runtime ready (service from local collection)");
  return offPeakRuntime;
}

function disposeOffPeakRuntime(): void {
  if (!offPeakRuntime) return;
  offPeakRuntime = null;
}

interface OffPeakRunDispatchRequest {
  offPeakTaskId: string;
  prompt: string;
  permissionMode: string;
  modelSelection: ModelSelection;
  conversationId?: string;
  sessionId?: string;
  serverTicketId?: string;
  workspacePath: string;
  workspaceIdentity?: string;
  projectId?: string | null;
  hostId?: string;
  additionalDirectories?: string[];
}

function offPeakRunSubscriptionKey(taskId: string, traceId: TraceId): string {
  return `${taskId}\u0000${traceId}`;
}

function disposeOffPeakRunSubscription(key: string): void {
  const disposable = offPeakRunSubscriptions.get(key);
  if (!disposable) return;
  offPeakRunSubscriptions.delete(key);
  disposable.dispose();
}

/** Terminal backfill of files_changed: reuses the existing task diff summary (counts tool file writes; Bash-side changes are not counted, accepted). */
async function resolveOffPeakFilesChanged(params: {
  zcodeTaskService: IZCodeTaskService;
  taskId: string;
  workspacePath: string;
  workspaceIdentity?: string;
}): Promise<number | undefined> {
  try {
    const snapshot = await params.zcodeTaskService.getTaskSnapshot({
      taskId: params.taskId,
      workspacePath: params.workspacePath,
      ...(params.workspaceIdentity ? { workspaceIdentity: params.workspaceIdentity } : {}),
    });
    const fileChanges = snapshot?.fileChanges;
    if (!fileChanges) return undefined;
    // An empty summary (no file changes) counts as 0; "0 files changed" is real information for the completion notice.
    return buildTaskChangeSummary(fileChanges)?.fileCount ?? 0;
  } catch (error) {
    logger.warn("off-peak files_changed 汇总失败（不阻塞终态落库）:", error);
    return undefined;
  }
}

/** loop terminal state → off_peak_tasks terminal state: succeeded→completed, stopped→cancelled (stopped by the user), anything else→failed. */
async function finalizeOffPeakRun(params: {
  zcodeTaskService: IZCodeTaskService;
  offPeakTaskId: string;
  taskId: string;
  workspacePath: string;
  workspaceIdentity?: string;
  outcome: ZCodeAutomationRunOutcome;
  error?: string;
}): Promise<void> {
  const status =
    params.outcome === "succeeded"
      ? ("completed" as const)
      : params.outcome === "stopped"
        ? ("cancelled" as const)
        : ("failed" as const);
  const filesChanged = await resolveOffPeakFilesChanged(params);
  const updated = await offPeakTaskRepo.markTerminal(params.offPeakTaskId, {
    status,
    endedAt: Date.now(),
    ...(params.error ? { failureReason: params.error } : {}),
    ...(filesChanged !== undefined ? { filesChanged } : {}),
  });
  if (!updated) {
    // Terminal states are irreversible: if the task was already cancelled or deleted by the user, drop the late write-back (idempotent fallback).
    logger.info(
      `off-peak terminal writeback dropped (already terminal) task=${params.offPeakTaskId}`,
    );
    return;
  }
  logger.info(
    `off-peak run finished task=${params.offPeakTaskId} status=${status} filesChanged=${filesChanged ?? "n/a"}`,
  );
  // Background completion marks the task unread; the navigation path clears it when the task is opened (same as cron).
  void params.zcodeTaskService.setTaskUnread({
    taskId: params.taskId,
    workspacePath: params.workspacePath,
    ...(params.workspaceIdentity ? { workspaceIdentity: params.workspaceIdentity } : {}),
    unread: true,
  });
}

function trackOffPeakRunOutcome(params: {
  zcodeTaskService: IZCodeTaskService;
  zcodeAgentService: IZCodeAgentService;
  service: OffPeakTaskService;
  ticketId: string;
  offPeakTaskId: string;
  taskId: string;
  traceId: TraceId;
  workspacePath: string;
  workspaceIdentity?: string;
}): { admitted(): void } {
  const key = offPeakRunSubscriptionKey(params.taskId, params.traceId);
  disposeOffPeakRunSubscription(key);
  const target = {
    workspacePath: params.workspacePath,
    workspaceIdentity: params.workspaceIdentity,
  };
  // Check before registering so an unsupported Source does not leave a resident execution behind.
  const onLifecycle = params.zcodeAgentService.onDynamicOffPeakLifecycle;
  if (!onLifecycle) throw new Error("Off-peak lifecycle events unsupported by this Source");
  const registration = params.service.residentExecutions.register({
    offPeakTaskId: params.offPeakTaskId,
    executionId: params.traceId,
    sessionId: params.taskId,
    ticketId: params.ticketId,
    control: (control) => {
      // The agent service marks these optional for older Sources; a missing method is an explicit failure.
      const controlExecution = params.zcodeAgentService.controlOffPeakExecutionV4;
      if (!controlExecution)
        throw new Error("Off-peak execution control unsupported by this Source");
      return controlExecution.call(params.zcodeAgentService, { ...target, control });
    },
    complete: (outcome) => finalizeOffPeakRun({ ...params, outcome }),
    disposed: () => disposeOffPeakRunSubscription(key),
  });
  const disposable = onLifecycle.call(
    params.zcodeAgentService,
    target,
  )((event) => {
    if (event.executionId !== params.traceId || event.sessionId !== params.taskId) return;
    void params.service.residentExecutions
      .handle(event)
      .catch((error) => logger.warn("off-peak 生命周期处理失败:", error));
  });
  offPeakRunSubscriptions.set(key, {
    dispose() {
      disposable.dispose();
      registration.dispose();
    },
  });
  return registration;
}

/**
 * Submits one off-peak dispatch to the current host's V4 task service.
 * The first run calls createTask; an in-process ticket swap only delivers the existing execution and never re-sends the initial prompt.
 * Recovering an interrupted task row still reuses the session; it does not resume the old process's background work or notifications.
 */
async function dispatchOffPeakRun(request: OffPeakRunDispatchRequest): Promise<{
  conversationId?: string;
  sessionId?: string;
  lifecycleManaged: true;
}> {
  const zcodeTaskService = activeServices?.getOptional(IZCodeTaskService);
  const zcodeAgentService = activeServices?.getOptional(IZCodeAgentService);
  if (!zcodeTaskService || !zcodeAgentService) {
    throw new Error("ZCode task service is not initialized.");
  }
  const runtime = await ensureOffPeakRuntime();
  if (!runtime) {
    throw new Error("off-peak runtime is not available");
  }
  if (!request.serverTicketId) {
    // schedulable always has a ticket number; a dispatch without one means the snapshot is out of order, so reply transient and wait for the next round (polling will issue the ticket).
    throw new Error("off-peak dispatch without server ticket");
  }
  const currentTask = await offPeakTaskRepo.get(request.offPeakTaskId);
  if (!currentTask || isOffPeakTerminalStatus(currentTask.status)) {
    // Scheduling claims and CLI close-out can interleave; a late dispatch must not replay a task that has already finished.
    await runtime.service.residentExecutions.discardTicket(request.serverTicketId);
    const sessionId = currentTask?.conversationId ?? request.conversationId ?? request.sessionId;
    return { conversationId: sessionId, sessionId, lifecycleManaged: true };
  }
  if (runtime.service.residentExecutions.has(request.offPeakTaskId)) {
    const stillNeedsTicket = runtime.service.residentExecutions.retakeGuard(request.offPeakTaskId);
    const auth = runtime.service.residentExecutions.isUserOwned(request.offPeakTaskId)
      ? {}
      : await runtime.buildRequestAuth(request.serverTicketId);
    // Write running before waking the CLI; otherwise a requeue produced by a request that expires immediately would be overwritten by the late acknowledgement.
    await offPeakTaskRepo.markRunning(request.offPeakTaskId, { startedAt: Date.now() });
    try {
      const resident = await runtime.service.residentExecutions.deliverTicket(
        request.offPeakTaskId,
        request.serverTicketId,
        auth,
      );
      if (resident)
        return {
          conversationId: resident.sessionId,
          sessionId: resident.sessionId,
          lifecycleManaged: true,
        };
      // The resident execution may finish and deregister while credentials are being obtained; this dispatch already belongs to the ticket continuation, so it must not be downgraded to an initial prompt.
      await runtime.service.residentExecutions.discardTicket(request.serverTicketId);
      const sessionId = currentTask.conversationId ?? request.conversationId ?? request.sessionId;
      return { conversationId: sessionId, sessionId, lifecycleManaged: true };
    } catch (error) {
      // An RPC in flight may coincide with a user takeover or whole-item completion; a failed receipt must not reclaim scheduling ownership.
      if (stillNeedsTicket()) await offPeakTaskRepo.requeueForContinuation(request.offPeakTaskId);
      throw error;
    }
  }
  // The off-peak Selection only carries in-memory continuation; ordinary Session entries and the CLI do not persist it by default.
  const idleSelection = request.modelSelection;
  if (!(await runtime.validateSelection(idleSelection))) {
    throw new OffPeakModelUnavailableError("idlePlan");
  }
  const requestAuth = await runtime.buildRequestAuth(request.serverTicketId);
  // Whether a first dispatch and a recovery dispatch on a reused session can be told apart in the turn facts; this field only describes
  // the scheduling phase of the current automatic turn and does not change the stable task ID, the independent message ID, or manual-message semantics.
  const dispatchKind = resolveOffPeakDispatchKind(request);
  const offPeakRunType = dispatchKind === "resume" ? "resume" : "init";
  let trackedKey: string | null = null;
  try {
    let taskId: string;
    let traceId: TraceId;
    let promptContent = request.prompt;
    if (dispatchKind === "bound-first-run") {
      // Bound first run: a task created inside a session runs in the session that created it (aligned with the targetTaskId path of dispatchCronRun).
      // Probe before writing config: the bound session is the user's working session; when busy, hand off as transient to the scheduler for backoff,
      // and do not setMode before session/send, which would be rejected with -32010 (that would silently change the user session's permission mode).
      taskId = request.sessionId!;
      traceId = `${request.offPeakTaskId}:bound:${randomUUID()}` as TraceId;
      const workspaceScope = {
        workspacePath: request.workspacePath,
        workspaceIdentity: request.workspaceIdentity,
        additionalDirectories: request.additionalDirectories,
      };
      // Bug cause: after the ownership consolidation, the tasks-index row status only mirrors the CLI's last_outcome,
      // so it is never running; the old busy check based on listTasks(...).status === "running" became invalid,
      // and off-peak tasks could be dispatched to a bound session that is still running. Running state can only come from the syncer's active set.
      const [deletedIds, activeIds] = await Promise.all([
        zcodeTaskService.listDeletedTaskIds(workspaceScope),
        zcodeTaskService.listActiveTaskIds(workspaceScope),
      ]);
      assertBoundSessionDispatchable({
        sessionId: taskId,
        deleted: deletedIds.includes(taskId),
        running: activeIds.includes(taskId),
      });
      await zcodeTaskService.resumeTask({
        ...workspaceScope,
        taskId,
        // The bound session stamps the ownership marker on first use so the sidebar groups it under off-peak (same mechanism as cron targetTaskId).
        offPeakTaskId: request.offPeakTaskId,
      });
      await zcodeTaskService.setConfigOption({
        taskId,
        traceId,
        configId: "mode",
        value: request.permissionMode,
      });
    } else if (dispatchKind === "resume") {
      // Continuation segment: resume the same session (cold recovery hydrates history; resume must happen before send).
      taskId = request.conversationId!;
      // Reason: offPeakTaskId is only used to correlate across talks; each automatic turn must generate its own message identity,
      // it must not reuse the task ID, and it must not rely on same-millisecond timestamps to avoid collisions.
      traceId = `${request.offPeakTaskId}:resume:${randomUUID()}` as TraceId;
      promptContent = OFF_PEAK_RESUME_PROMPT;
      await zcodeTaskService.resumeTask({
        taskId,
        workspacePath: request.workspacePath,
        workspaceIdentity: request.workspaceIdentity,
        additionalDirectories: request.additionalDirectories,
        // D48: a pre-stamped session continuation backfills the ownership marker (a second safeguard beyond the bootstrap backfill).
        offPeakTaskId: request.offPeakTaskId,
      });
      // The permission mode is sent with the dispatch (set explicitly after resume; idempotent).
      await zcodeTaskService.setConfigOption({
        taskId,
        traceId,
        configId: "mode",
        value: request.permissionMode,
      });
      // The effort level is part of the idle Selection and is injected only in sendPrompt; writing it separately would pollute the user's session.
    } else {
      const task = await zcodeTaskService.createTask({
        projectId: request.projectId,
        workspacePath: request.workspacePath,
        workspaceIdentity: request.workspaceIdentity,
        additionalDirectories: request.additionalDirectories,
        // An empty Session follows ordinary initialization; the idle Selection is only injected in the execution below.
        // Writing it here would let ordinary messages after the off-peak turn ends keep using the ticketless hidden Provider.
        mode: request.permissionMode as ZCodeTaskMode,
        // The off-peak task is a headless createTask + sendPrompt sequence; an empty session must be persisted first, within the
        // V4 admission, otherwise the session_input foreign key would be written before the session's main record.
        deferPersistenceUntilFirstPrompt: true,
        // Creating it stamps the persistent ownership marker (the moon icon and later system groups only check this marker, without looking up the store).
        offPeakTaskId: request.offPeakTaskId,
      });
      taskId = task.taskId;
      traceId = task.traceId;
    }
    // Preparing the session involves async I/O; the task may be cancelled meanwhile, so it must be rechecked before the first prompt is admitted.
    const beforeAdmission = await offPeakTaskRepo.get(request.offPeakTaskId);
    if (!beforeAdmission || isOffPeakTerminalStatus(beforeAdmission.status)) {
      await runtime.service.residentExecutions.discardTicket(request.serverTicketId);
      return { conversationId: taskId, sessionId: taskId, lifecycleManaged: true };
    }
    trackedKey = offPeakRunSubscriptionKey(taskId, traceId);
    const lifecycle = trackOffPeakRunOutcome({
      zcodeTaskService,
      zcodeAgentService,
      service: runtime.service,
      ticketId: request.serverTicketId,
      offPeakTaskId: request.offPeakTaskId,
      taskId,
      traceId,
      workspacePath: request.workspacePath,
      ...(request.workspaceIdentity ? { workspaceIdentity: request.workspaceIdentity } : {}),
    });
    await zcodeTaskService.sendPrompt({
      taskId,
      traceId,
      content: promptContent,
      clientMode: "desktop-continuous",
      // Bug cause: the off-peak auto turn used to inject only the idle plan and did not restrict the tool surface, so the model could create
      // persistent scheduled tasks in the background. The first run and continuations converge here, explicitly hide CronCreate, and do not fake cron automation ownership.
      // The off-peak turn also hides OffPeakCreate; OffPeakList stays read-only.
      toolDenylist: ["CronCreate", "OffPeakCreate"],
      modelSelection: idleSelection,
      modelExecution: {
        // Off-peak execution credentials serve only the main turn; no automatic Memory request is spawned after it completes.
        memoryExtraction: "skip",
        selectionScope: "execution",
        offPeak: {
          executionId: traceId,
          ticketId: request.serverTicketId,
          providerErrorCode: "3102",
        },
        requestAuth,
        subagents: {
          foregroundModel: "submission",
          background: "allow",
        },
      },
      offPeakTaskId: request.offPeakTaskId,
      offPeakRunType,
    });
    await offPeakTaskRepo.markRunning(request.offPeakTaskId, {
      startedAt: Date.now(),
      conversationId: taskId,
      sessionId: taskId,
    });
    lifecycle.admitted();
    // Only a newly created init counts; the bound first run and cross-ticket continuation are just follow-up input to the original Session.
    if (dispatchKind === "init") {
      reportHostSessionCreate(parentPort, {
        sessionId: taskId,
        messageId: traceId,
        source: "automation_idle",
        workspaceIdentity: request.workspaceIdentity,
      });
    }
    return { conversationId: taskId, sessionId: taskId, lifecycleManaged: true };
  } catch (error) {
    if (trackedKey) disposeOffPeakRunSubscription(trackedKey);
    throw error;
  }
}

interface CronRunDispatchRequest {
  automationId: string;
  runId: string;
  prompt: string;
  targetTaskId?: string;
  modelSelection?: ModelSelection;
  mode?: ZCodeTaskMode;
  workspacePath: string;
  workspaceIdentity?: string;
  projectId?: string | null;
  hostId?: string;
  additionalDirectories?: string[];
}

function resolveAutomationTargetServices(request: {
  workspacePath: string;
  workspaceIdentity?: string;
}): ServiceCollection {
  const remoteSession = windowRemoteConnectionRegistry.findSessionForWorkspace(request);
  if (remoteSession) {
    if (!remoteSession.workspaceIdentity) {
      throw new Error("Automation 目标 Remote Host 缺少 workspaceIdentity");
    }
    return windowRemoteConnectionRegistry.resolveScopedServices({
      kind: "remote",
      remoteSessionId: remoteSession.remoteSessionId,
      workspacePath: request.workspacePath,
      workspaceIdentity: remoteSession.workspaceIdentity,
    });
  }
  // When a remote Automation cannot find its target logical session, the old dispatch silently fell back to the Local Host,
  // and used the local model preference and Registry. A remote identity may only fail, never fall back across Environments.
  if (request.workspaceIdentity && isRemoteWorkspaceIdentity(request.workspaceIdentity)) {
    throw new Error("Automation 目标 Remote Host 当前不可用");
  }
  if (!activeServices) {
    throw new Error("Local Host services are not initialized.");
  }
  return activeServices;
}

function cronRunSubscriptionKey(taskId: string, traceId: TraceId): string {
  return `${taskId}\u0000${traceId}`;
}

function parseCronRunScheduledAt(runId: string, automationId: string): number | null {
  const prefix = `${automationId}:`;
  if (!runId.startsWith(prefix)) return null;
  const value = Number(runId.slice(prefix.length).split(":")[0]);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

function markCronRunOutcome(params: {
  runId: string;
  automationId: string;
  workspaceKey: string;
  scheduledAt: number | null;
  trigger: "schedule" | "manual";
  outcome: ZCodeAutomationRunOutcome;
  error?: string;
}): void {
  void recordCronRunOutcomeBestEffort({
    ...params,
    repo: cronAutomationRepo,
    logWarn: (message, error) => logger.warn(message, error),
  });
}

function disposeCronRunSubscription(key: string): void {
  const disposable = cronRunSubscriptions.get(key);
  if (!disposable) return;
  cronRunSubscriptions.delete(key);
  disposable.dispose();
}

async function applyCronRunConfigToExistingTask(params: {
  zcodeTaskService: IZCodeTaskService;
  taskId: string;
  traceId: TraceId;
  modelSelection?: ModelSelection;
  mode?: string;
}): Promise<void> {
  let thoughtAppliedWithModel = false;
  let modeAppliedWithModel = false;
  if (params.modelSelection) {
    await params.zcodeTaskService.setAutomationSessionConfig({
      taskId: params.taskId,
      traceId: params.traceId,
      modelSelection: params.modelSelection,
      thoughtLevel: params.modelSelection.options?.reasoningLevel,
      mode: params.mode?.trim() as ZCodeTaskMode | undefined,
    });
    thoughtAppliedWithModel = true;
    modeAppliedWithModel = true;
  }
  if (!modeAppliedWithModel && params.mode?.trim()) {
    await params.zcodeTaskService.setConfigOption({
      taskId: params.taskId,
      traceId: params.traceId,
      configId: "mode",
      value: params.mode.trim(),
    });
  }
  if (!thoughtAppliedWithModel && params.modelSelection?.options?.reasoningLevel) {
    await params.zcodeTaskService.setConfigOption({
      taskId: params.taskId,
      traceId: params.traceId,
      configId: "thought_level",
      value: params.modelSelection.options.reasoningLevel,
    });
  }
}

function trackCronRunOutcome(params: {
  zcodeTaskService: IZCodeTaskService;
  taskId: string;
  traceId: TraceId;
  workspacePath: string;
  workspaceIdentity?: string;
  runId: string;
  automationId: string;
  workspaceKey: string;
  scheduledAt: number | null;
  trigger: "schedule" | "manual";
}): void {
  const key = cronRunSubscriptionKey(params.taskId, params.traceId);
  disposeCronRunSubscription(key);
  markCronRunOutcome({ ...params, outcome: "running" });
  const disposable = params.zcodeTaskService.onDynamicTaskTerminalOutcome(params.taskId)(
    (result) => {
      if (result.inputId !== params.traceId) return;
      void settleCronRunTerminalOutcome({
        ...params,
        outcome: result.outcome,
        error: result.error,
        repo: cronAutomationRepo,
        logWarn: (message, error) => logger.warn(message, error),
      });
      // Scheduled tasks are marked unread uniformly after background completion; the navigation path clears it when the task is actually opened.
      void params.zcodeTaskService.setTaskUnread({
        taskId: params.taskId,
        workspacePath: params.workspacePath,
        ...(params.workspaceIdentity ? { workspaceIdentity: params.workspaceIdentity } : {}),
        unread: true,
      });
      disposeCronRunSubscription(key);
    },
  );
  const claimHeartbeat =
    params.trigger === "manual"
      ? startManualClaimHeartbeat({
          ...params,
          repo: cronAutomationRepo,
          logWarn: (message, error) => logger.warn(message, error),
        })
      : null;
  cronRunSubscriptions.set(key, {
    dispose() {
      claimHeartbeat?.dispose();
      disposable.dispose();
    },
  });
}

/**
 * Submits one cron/manual run directly to the current host's V4 task service.
 * The automation may be bound to an inactive session, so the session must be resumed before the saved run parameters are applied.
 */
async function dispatchCronRun(request: CronRunDispatchRequest): Promise<{
  taskId: string;
  sessionId: string;
}> {
  const targetServices = resolveAutomationTargetServices(request);
  const zcodeTaskService = targetServices.getOptional(IZCodeTaskService);
  if (!zcodeTaskService) {
    throw new Error("ZCode task service is not initialized.");
  }
  const modelSelectionService = targetServices.getOptional(IModelSelectionService);
  if (!modelSelectionService) {
    throw new Error("目标 Host Model Selection service is not initialized.");
  }
  // The long-term config is the original intent; the first dispatch is fixed after the target Host is resolved. An existing run must be reused directly,
  // and must not reinterpret the historical execution choice because the account changed or this Registry read failed.
  const existingRun = await cronAutomationRepo.getRun(request.runId);
  const resolvedSubmissionModelSelection = await resolveAutomationSubmissionModelSelection({
    selection: request.modelSelection,
    fixedSelection: existingRun?.modelSelection,
    modelSelectionService,
    // The Repo has already completed the offline import before reading; no longer routes migration through the Agent/account service.
    // A value that was not migrated or is corrupt is still explicitly rejected here and must not be treated as following the Workspace.
    readSelection: () =>
      cronAutomationRepo.getModelSelectionForDispatch(
        request.automationId,
        resolveWorkspaceKey(request),
      ),
  });
  const submissionModelSelection = await cronAutomationRepo.fixRunModelSelection(
    request.runId,
    resolvedSubmissionModelSelection,
  );
  let trackedKey: string | null = null;
  const workspaceKey = resolveWorkspaceKey(request);
  const trigger = request.runId.includes(":manual:") ? "manual" : "schedule";
  const scheduledAt = parseCronRunScheduledAt(request.runId, request.automationId);
  try {
    const task = request.targetTaskId
      ? { taskId: request.targetTaskId }
      : await zcodeTaskService.createTask({
          projectId: request.projectId,
          workspacePath: request.workspacePath,
          workspaceIdentity: request.workspaceIdentity,
          additionalDirectories: request.additionalDirectories,
          model: formatModelPickerValue(submissionModelSelection),
          mode: request.mode,
          thoughtLevel: submissionModelSelection.options?.reasoningLevel,
          automationId: request.automationId,
        });
    // When the task is not bound to a session, the session trace from createTask must not be reused as the first prompt trace:
    // the CLI cannot recover the manual/schedule admission from inputId.
    // The session-creation trace and the execution runId are two different identities; both dispatch paths must use runId for the prompt.
    const promptTraceId = request.runId as TraceId;
    if (request.targetTaskId) {
      // A bound session is usually not active after an app restart or workspace switch; the old code directly
      // setConfig/sendPrompt reported "Session is not active", which looked like "Run now" did nothing.
      await zcodeTaskService.resumeTask({
        taskId: task.taskId,
        workspacePath: request.workspacePath,
        workspaceIdentity: request.workspaceIdentity,
        additionalDirectories: request.additionalDirectories,
        model: formatModelPickerValue(submissionModelSelection),
        thoughtLevel: submissionModelSelection.options?.reasoningLevel,
        automationId: request.automationId,
      });
      await applyCronRunConfigToExistingTask({
        zcodeTaskService,
        taskId: task.taskId,
        traceId: promptTraceId,
        modelSelection: submissionModelSelection,
        mode: request.mode,
      });
    }
    const botsService = targetServices.getOptional(IBotsService);
    if (botsService) {
      try {
        await watchCronRunBotDelivery({
          automationId: request.automationId,
          runId: promptTraceId,
          workspaceKey,
          workspacePath: request.workspacePath,
          ...(request.workspaceIdentity ? { workspaceIdentity: request.workspaceIdentity } : {}),
          taskId: task.taskId,
          repo: cronAutomationRepo,
          botsService,
        });
      } catch (error) {
        // Bot push-back is a best-effort side channel; config/credential/subscription failures must not block automation dispatch or settlement.
        logger.warn(
          `automation Bot delivery subscription failed automation=${request.automationId} provider=unknown`,
          error,
        );
      }
    }
    trackedKey = cronRunSubscriptionKey(task.taskId, promptTraceId);
    trackCronRunOutcome({
      zcodeTaskService,
      taskId: task.taskId,
      traceId: promptTraceId,
      workspacePath: request.workspacePath,
      workspaceIdentity: request.workspaceIdentity,
      runId: request.runId,
      automationId: request.automationId,
      workspaceKey,
      scheduledAt,
      trigger,
    });
    await zcodeTaskService.sendPrompt({
      taskId: task.taskId,
      traceId: promptTraceId,
      content: request.prompt,
      clientMode: "desktop-continuous",
      automationId: request.automationId,
    });
    // A scheduled task created by a prompt carries targetTaskId, so appending to the original session must not be counted as session_create.
    if (!request.targetTaskId) {
      reportHostSessionCreate(parentPort, {
        sessionId: task.taskId,
        messageId: promptTraceId,
        source: "automation_scheduled",
        workspaceIdentity: request.workspaceIdentity,
      });
    }
    return { taskId: task.taskId, sessionId: task.taskId };
  } catch (error) {
    if (trackedKey) disposeCronRunSubscription(trackedKey);
    markCronRunOutcome({
      runId: request.runId,
      automationId: request.automationId,
      workspaceKey,
      scheduledAt,
      trigger,
      outcome: "failed",
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

async function dispatchManualAutomationRun(params: {
  automation: ZCodeAutomation;
  run: ZCodeAutomationRun;
}): Promise<void> {
  logger.info(
    `direct manual automation dispatch started automation=${params.automation.automationId} runId=${params.run.runId}`,
  );
  let result: Awaited<ReturnType<typeof dispatchCronRun>>;
  try {
    result = await dispatchCronRun({
      automationId: params.automation.automationId,
      runId: params.run.runId,
      prompt: params.automation.prompt,
      targetTaskId: params.automation.targetTaskId,
      modelSelection: params.run.modelSelection ?? params.automation.modelSelection,
      mode: params.automation.mode,
      workspacePath: params.automation.workspacePath,
      workspaceIdentity: params.automation.workspaceIdentity,
      projectId: params.automation.projectId,
      hostId: params.automation.hostId,
      additionalDirectories: params.automation.additionalDirectories,
    });
  } catch (error) {
    logger.warn(
      `direct manual automation dispatch failed automation=${params.automation.automationId} runId=${params.run.runId}:`,
      error,
    );
    await settleManualDispatchFailureBestEffort({
      repo: cronAutomationRepo,
      automationId: params.automation.automationId,
      runId: params.run.runId,
      workspaceKey: params.automation.workspaceKey,
      scheduledAt: params.run.scheduledAt ?? null,
      trigger: "manual",
      dispatchError: error,
      logWarn: (message, releaseError) => logger.warn(message, releaseError),
    });
    throw error;
  }

  try {
    await cronAutomationRepo.markManualRunDispatched({
      runId: params.run.runId,
      sessionId: result.sessionId,
      dispatchedAt: Date.now(),
    });
  } catch (error) {
    // The prompt has already been accepted/queued; a failure to write back the ledger and cumulative count must not be reported as a dispatch failure and release the lock early;
    // the real terminal state is still closed by trackCronRunOutcome, avoiding duplicate queuing of the same automation.
    logger.warn(
      `回写 manual automation dispatched 状态与运行次数失败 automation=${params.automation.automationId} runId=${params.run.runId}`,
      error,
    );
  }
  // The sendPrompt ACK may only mean the prompt entered the busy queue; the manual claim must be kept until the corresponding turn reaches a terminal state.
  logger.info(
    `direct manual automation dispatch accepted automation=${params.automation.automationId} runId=${params.run.runId} taskId=${result.taskId}`,
  );
}

// A Node warning is not a remote connection failure; turn it into a structured warn so the default stderr is not mislabeled as an error.
process.on("warning", (warning) => logger.warn(`${warning.name}: ${warning.message}`));

registerHostNetworkTelemetry(parentPort);
// Host process's own 60-second sampling: one reading has two outputs: after gating, it writes a local
// `[memory]` line, and the same reading is converted to a HostResourceSample and sent to main via parentPort as the heap source.
// Service counters are self-registered by each service factory.
const hostSelfResourceTelemetry = startHostSelfResourceTelemetry({
  logger,
  collectCounters: collectServiceMemoryDiagnostics,
  postMessage: parentPort ? (message) => parentPort.postMessage(message) : undefined,
});

const runtimeProcessLifecycleReporter = {
  onSpawn(event) {
    if (!parentPort) {
      return;
    }

    parentPort.postMessage({
      type: HostResponseTypes.AgentProcessSpawned,
      ...event,
    });
  },
  onReady(event) {
    if (!parentPort) {
      return;
    }

    parentPort.postMessage({
      type: HostResponseTypes.AgentProcessReady,
      ...event,
    });
  },
  onExit(event) {
    if (!parentPort) {
      return;
    }

    parentPort.postMessage({
      type: HostResponseTypes.AgentProcessExited,
      ...event,
      signal: event.signal ?? null,
    });
  },
  onError(event) {
    if (!parentPort) {
      return;
    }

    parentPort.postMessage({
      type: HostResponseTypes.AgentProcessError,
      ...event,
    });
  },
  onException(event) {
    parentPort?.postMessage({ type: HostResponseTypes.AgentProcessException, ...event });
  },
} satisfies NonNullable<Parameters<typeof createLocalServices>[0]>["processLifecycleReporter"];

const runtimeTaskReporter = {
  onRunningTaskCountChanged(event) {
    if (!parentPort) {
      return;
    }

    parentPort.postMessage({
      type: HostResponseTypes.AgentRunningTaskCountChanged,
      runningTaskCount: event.runningTaskCount,
    });
  },
} satisfies NonNullable<Parameters<typeof createLocalServices>[0]>["taskRuntimeReporter"];

const cuaOperationStateReporter = {
  onStateChanged(event) {
    if (!parentPort) {
      return;
    }
    parentPort.postMessage({
      type: HostResponseTypes.CuaOperationState,
      ...event,
    });
  },
} satisfies NonNullable<Parameters<typeof createLocalServices>[0]>["cuaOperationStateReporter"];

let untrackedPromptRpcCount = 0;
function reportHostRunningTaskCount(): void {
  runtimeTaskReporter.onRunningTaskCountChanged({
    runningTaskCount: workspaceTaskTracker.getTotalRunningTaskCount() + untrackedPromptRpcCount,
  });
}

const workspaceTaskTracker = createHostWorkspaceTaskTracker((event) => {
  parentPort?.postMessage({
    type: HostResponseTypes.WorkspaceRunningTaskCountChanged,
    ...event,
  });
  windowRemoteConnectionRegistry.setWorkspaceRunningTaskCount(event);
  reportHostRunningTaskCount();
});

function isZCodeTaskMeta(value: unknown): value is ZCodeTaskMeta {
  return (
    typeof value === "object" &&
    value !== null &&
    "taskId" in value &&
    "workspacePath" in value &&
    "traceId" in value &&
    typeof (value as { taskId?: unknown }).taskId === "string" &&
    typeof (value as { workspacePath?: unknown }).workspacePath === "string" &&
    typeof (value as { traceId?: unknown }).traceId === "string"
  );
}

function isRemoteMirrorableStreamEvent(
  event: ZCodeStreamEvent,
): event is TaskStreamMirrorableEvent {
  return event.type !== "task_stream_mirror_batch" && event.type !== "task_snapshot_updated";
}

function createReportingRemoteZCodeTaskService<T extends object>(
  service: T,
  options?: {
    reportRunningPromptCount?: boolean;
    taskRealtimePort?: ReturnType<typeof createTaskRealtimeBridgeForHostInit>;
    materializePromptAttachments?: (params: {
      taskId: string;
      traceId: TraceId;
      content: string;
      attachments?: ZCodePromptAttachment[];
    }) => Promise<{ content: string; attachments?: ZCodePromptAttachment[] }>;
  },
): T {
  const workspaceProxyState = createHostRemoteWorkspaceProxyState();

  function forwardSessionMessageRequest(request: unknown): void {
    parentPort?.postMessage({
      type: HostResponseTypes.SessionMessageSendRequested,
      request,
    });
  }

  function subscribeSessionMessageRequests(target: T, meta: ZCodeTaskMeta): void {
    const onDynamicWorkspaceEvent = Reflect.get(target, "onDynamicWorkspaceEvent");
    if (typeof onDynamicWorkspaceEvent !== "function") {
      return;
    }
    const subscribe = onDynamicWorkspaceEvent.call(target, {
      workspacePath: meta.workspacePath,
      ...(meta.workspaceIdentity ? { workspaceIdentity: meta.workspaceIdentity } : {}),
    });
    if (typeof subscribe !== "function") {
      return;
    }
    workspaceProxyState.ensureWorkspaceSubscription(meta, () =>
      subscribe((event: unknown) => {
        if (
          typeof event === "object" &&
          event !== null &&
          (event as { type?: unknown }).type === "workspace_session_message_send_requested"
        ) {
          forwardSessionMessageRequest((event as { request?: unknown }).request);
        }
      }),
    );
  }

  function rememberTaskMeta(result: unknown): void {
    if (isZCodeTaskMeta(result)) {
      workspaceProxyState.rememberTaskMeta(result);
      subscribeSessionMessageRequests(service, result);
      parentPort?.postMessage({
        type: HostResponseTypes.SessionRouteAnnounce,
        route: {
          sessionId: result.taskId,
        },
      });
    }
  }

  function rememberTaskMetasFromResult(result: unknown): void {
    if (Array.isArray(result)) {
      for (const item of result) {
        rememberTaskMetasFromResult(item);
      }
      return;
    }
    rememberTaskMeta(result);
    if (typeof result !== "object" || result === null) {
      return;
    }
    const items = (result as { items?: unknown }).items;
    if (Array.isArray(items)) {
      for (const item of items) {
        rememberTaskMeta(item);
      }
    }
    const snapshot = (result as { snapshot?: unknown }).snapshot;
    if (typeof snapshot === "object" && snapshot !== null) {
      rememberTaskMeta((snapshot as { meta?: unknown }).meta);
    }
    rememberTaskMeta((result as { meta?: unknown }).meta);
  }

  async function prepareRemotePromptParams(params: {
    taskId: string;
    traceId: TraceId;
    content: string;
    attachments?: ZCodePromptAttachment[];
  }): Promise<{
    taskId: string;
    traceId: TraceId;
    content: string;
    attachments?: ZCodePromptAttachment[];
  }> {
    if (!options?.materializePromptAttachments) {
      return params;
    }
    return {
      ...params,
      ...(await options.materializePromptAttachments(params)),
    };
  }

  async function mirrorRemotePrompt(
    target: T,
    sendPrompt: (...args: unknown[]) => Promise<unknown>,
    params: {
      taskId: string;
      traceId: TraceId;
      content: string;
      attachments?: ZCodePromptAttachment[];
    },
  ): Promise<unknown> {
    const taskRealtimePort = options?.taskRealtimePort;
    const meta = workspaceProxyState.getTaskMeta(params.taskId);
    if (!taskRealtimePort || !meta) {
      return sendPrompt.call(target, params);
    }

    const mirrorTarget = {
      workspacePath: meta.workspacePath,
      workspaceIdentity: meta.workspaceIdentity,
      workspaceKey: resolveWorkspaceKey(meta),
      taskId: params.taskId,
      runId: params.traceId,
      traceId: params.traceId,
    };
    const leaseResult = await taskRealtimePort
      .acquireTaskRunLease(mirrorTarget)
      .catch((error: unknown) => {
        logger.warn("Bot remote runtime realtime lease failed:", error);
        return null;
      });
    if (!leaseResult?.acquired) {
      return sendPrompt.call(target, params);
    }

    taskRealtimePort.publishStreamOp(mirrorTarget, {
      kind: "user_message",
      messageId: `user-${params.traceId}`,
      content: params.content,
      attachments: params.attachments,
      timestamp: Date.now(),
    });

    // The write path (send/stop/interaction receipts) has already converged on the v4 command surface; this mirror is the **read path**:
    // taskRealtimePort → mobile relay → mobile
    // The whole consumption chain of zcodeSessionStore is vocabulary of ZCodeStreamEvent. Assessment of the two options:
    // a) the relay forwards v4 frames directly and the mobile consumes the v4 store (the correct approach): requires redoing the relay stream-op
    //    protocol and the mobile store;
    // b) a thin frame→ZCodeStreamEvent mapping: equivalent to reimplementing the adapter's mapSessionEvent;
    //    rejected.
    // Conclusion: this mirror keeps the legacy source unchanged.
    const dynamicStreamEvent = Reflect.get(target, "onDynamicStreamEvent");
    const streamDisposable =
      typeof dynamicStreamEvent === "function"
        ? dynamicStreamEvent.call(
            target,
            params.taskId,
          )((event: ZCodeStreamEvent) => {
            if (isRemoteMirrorableStreamEvent(event)) {
              taskRealtimePort.publishStreamOp(mirrorTarget, {
                kind: "stream_event",
                event,
              });
            }
          })
        : null;

    try {
      return await sendPrompt.call(target, params);
    } finally {
      // The remote zcode-server has no desktop realtime port; the remote facade inside the window Host
      // takes over the lease and stream mirror, ensuring the UI keeps receiving the remote session stream.
      streamDisposable?.dispose();
      taskRealtimePort.releaseTaskRunLease(mirrorTarget);
    }
  }

  function finishWorkspaceTask(taskId: string, meta: ZCodeTaskMeta): void {
    workspaceProxyState.disposeTaskReadySubscription(taskId);
    workspaceTaskTracker.finish(taskId, meta);
  }

  function beginWorkspaceTask(target: T, taskId: string, meta: ZCodeTaskMeta): boolean {
    const started = workspaceTaskTracker.begin(taskId, meta);
    if (!started) {
      return false;
    }
    const onDynamicTaskReady = Reflect.get(target, "onDynamicTaskReady");
    if (typeof onDynamicTaskReady !== "function") {
      workspaceTaskTracker.finish(taskId, meta);
      throw new Error("remote ZCode task service does not expose onDynamicTaskReady");
    }
    const subscribe = onDynamicTaskReady.call(target, taskId);
    if (typeof subscribe !== "function") {
      workspaceTaskTracker.finish(taskId, meta);
      throw new Error("remote ZCode task ready event is not subscribable");
    }
    workspaceProxyState.trackTaskReady(
      taskId,
      meta,
      (listener) => subscribe(listener),
      () => finishWorkspaceTask(taskId, meta),
    );
    return true;
  }

  // The remote workspace's ZCode Agent manager runs on the remote server, so desktop main cannot see its
  // `handles` state. The sendPrompt Promise is only the remote ACK; the workspace may be reclaimed only after the task is ready.
  return new Proxy(service, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if ((property === "createTask" || property === "resumeTask") && typeof value === "function") {
        return async (...args: unknown[]) => {
          const result = await value.apply(target, args);
          rememberTaskMeta(result);
          return result;
        };
      }
      if (
        (property === "listTasks" ||
          property === "listPinnedTasks" ||
          property === "listTaskList" ||
          property === "listArchivedTasks" ||
          property === "getTaskMeta" ||
          property === "getTaskSnapshot" ||
          property === "getTaskSnapshotWithEtag") &&
        typeof value === "function"
      ) {
        return async (...args: unknown[]) => {
          const result = await value.apply(target, args);
          rememberTaskMetasFromResult(result);
          return result;
        };
      }
      if (property === "releaseWorkspacePreparation" && typeof value === "function") {
        return async (...args: unknown[]) => {
          const result = await value.apply(target, args);
          const context = args[0];
          if (
            typeof context === "object" &&
            context !== null &&
            typeof (context as { workspacePath?: unknown }).workspacePath === "string"
          ) {
            const workspaceContext = context as {
              workspacePath: string;
              workspaceIdentity?: string;
            };
            // A pooled Host does not exit with the tab; after the runtime is released successfully, the Host proxy-layer reference must also be cleared,
            // otherwise task meta and dynamic event listeners would grow monotonically for the whole app lifetime.
            workspaceProxyState.clearWorkspace(workspaceContext);
            workspaceTaskTracker.clearWorkspace(workspaceContext);
          }
          return result;
        };
      }
      const shouldWrapSendPrompt =
        options?.reportRunningPromptCount !== false ||
        Boolean(options?.taskRealtimePort) ||
        Boolean(options?.materializePromptAttachments);
      if (property !== "sendPrompt" || typeof value !== "function" || !shouldWrapSendPrompt) {
        return value;
      }

      return async (...args: unknown[]) => {
        let trackedTask: { taskId: string; meta: ZCodeTaskMeta; started: boolean } | undefined;
        let tracksOnlyRpcLifetime = false;
        try {
          const params = args[0];
          if (
            typeof params === "object" &&
            params !== null &&
            typeof (params as { taskId?: unknown }).taskId === "string" &&
            typeof (params as { traceId?: unknown }).traceId === "string" &&
            typeof (params as { content?: unknown }).content === "string"
          ) {
            const promptParams = params as {
              taskId: string;
              traceId: TraceId;
              content: string;
              attachments?: ZCodePromptAttachment[];
            };
            const taskMeta = workspaceProxyState.getTaskMeta(promptParams.taskId) as
              | ZCodeTaskMeta
              | undefined;
            if (taskMeta) {
              trackedTask = {
                taskId: promptParams.taskId,
                meta: taskMeta,
                started: beginWorkspaceTask(target, promptParams.taskId, taskMeta),
              };
            } else if (options?.reportRunningPromptCount !== false) {
              // When task meta is missing, the workspace identity cannot be safely forged; only keep the Host exit diagnostics during the ACK,
              // and do not let this fallback take part in the workspace runtime release decision.
              tracksOnlyRpcLifetime = true;
              untrackedPromptRpcCount += 1;
              reportHostRunningTaskCount();
            }
            const preparedParams = await prepareRemotePromptParams(promptParams);
            return await mirrorRemotePrompt(
              target,
              value.bind(target) as (...promptArgs: unknown[]) => Promise<unknown>,
              preparedParams,
            );
          }
          if (options?.reportRunningPromptCount !== false) {
            tracksOnlyRpcLifetime = true;
            untrackedPromptRpcCount += 1;
            reportHostRunningTaskCount();
          }
          return await value.apply(target, args);
        } catch (error) {
          if (trackedTask?.started) {
            finishWorkspaceTask(trackedTask.taskId, trackedTask.meta);
          }
          throw error;
        } finally {
          if (tracksOnlyRpcLifetime) {
            untrackedPromptRpcCount = Math.max(0, untrackedPromptRpcCount - 1);
            reportHostRunningTaskCount();
          }
        }
      };
    },
  });
}

function warmUpZCodeAgent(
  services: ServiceCollection,
  context: { workspacePath?: string; workspaceIdentity?: string },
  reason: string,
): void {
  if (!context.workspacePath) {
    return;
  }
  const workspacePath = context.workspacePath;
  const workspaceIdentity = context.workspaceIdentity;
  const zcodeSessionService = services.getOptional(IZCodeSessionService);
  if (!zcodeSessionService) {
    return;
  }
  void zcodeSessionService
    .initializeWorkspace({
      workspacePath,
      ...(workspaceIdentity ? { workspaceIdentity } : {}),
    })
    .then((result) => {
      if (!result.available) {
        if (result.reasonCode === "provider_not_ready") {
          logger.info(
            `ZCode agent warmup waiting for provider/model (${reason}) workspace=${workspacePath}`,
          );
          return;
        }
        logger.warn(
          `ZCode agent warmup unavailable (${reason}) workspace=${workspacePath} reason=${result.reason ?? "unknown"}`,
        );
        return;
      }
      // Model candidates and preferences are already provided by the target Host ModelSelectionView; the workspace
      // presentation only needs mode and slash commands. Warmup must not create an extra Agent App to read the presentation,
      // otherwise its MCP close would hold the protocol channel and block the real Session initialization.
      logger.info(
        `ZCode agent warmup ready (${reason}) workspace=${workspacePath} transport=${result.transportKind ?? "unknown"}`,
      );
    })
    .catch((error) => {
      logger.warn(`ZCode agent warmup failed (${reason}) workspace=${workspacePath}:`, error);
    });
}

// The background output poll still needs an independent debug logger, so the factory import must not be lost when other log callers are removed.
const rpcDebugLogger = createServiceLogger("rpc");

function logRpc(message: string, ...args: unknown[]): void {
  const level = resolveRpcLogLevel(message, ...args);
  if (level === "debug") {
    rpcDebugLogger.debug(undefined, message, ...args);
    return;
  }
  logger[level](message, ...args);
}

function formatRemoteTargetForLog(target: RemoteTarget): string {
  switch (target.kind) {
    case "ssh":
      return `ssh:${target.username}@${target.host}:${target.port ?? 22}`;
    case "wsl": {
      const user = target.user?.trim();
      const distro = target.distro ?? "default";
      return user ? `wsl:${distro}:${user}` : `wsl:${distro}`;
    }
    case "docker":
      return `docker:${target.container}`;
    case "server":
      return `server:${target.name?.trim() || target.url}`;
  }
}

console.log = (...args: unknown[]) => {
  rawConsole.log(...args);
  reportHostLog("info", args);
};

console.warn = (...args: unknown[]) => {
  rawConsole.warn(...args);
  reportHostLog("warn", args);
};

console.error = (...args: unknown[]) => {
  rawConsole.error(...args);
  // Electron routes Node warnings through console.error first, and the process warning listener then also
  // records a structured warn; reporting here as well would leave both an error and a warn for the same warning.
  if (!shouldReportHostConsoleError(args)) {
    return;
  }
  reportHostLog("error", args);
};

/** The set of services currently registered by the host, used to reclaim local resources uniformly on process exit */
let databaseStartup: ReturnType<typeof createHostDatabaseStartup> | undefined;
const pendingStartupAttachments = new Map<string, () => void>();
let activeServices: ServiceCollection | null = null;
/**
 * The real-time UI language pushed by Main, used as X-Client-Language for ZCode endpoint requests.
 * In the past the Host used the process Intl locale (a Dock launch without LANG falls back to en-US); a setting.json write may lag or fail,
 * and it does not represent the current UI, so only the InitLocal initial value and application-locale-changed updates from Main are trusted.
 */
let applicationLocale: Locale | undefined;
// Main holds InitLocal while another Host starts, so a locale change can reach this Host first; the older InitLocal value must not overwrite it.
let applicationLocaleChangedBeforeInit = false;
let activeHostApiNetworkTransport: HostApiNetworkTransport | null = null;
let sourceServerDirectory: SourceServerDirectory | null = null;
let sourceServerConnectionManager: SourceServerConnectionManager | null = null;
let sourceServerManagementService: SourceServerManagementService | null = null;
let sourceServerArtifactPolicy: SourceServerArtifactPolicy = "release-versioned";
const sourceServerDisplayNameById = new Map<string, string>();
let sourceSettingsStateSubscription: IDisposable | null = null;
const activeWorkspaceBindRequestIds = new Set<string>();
const cancelledWorkspaceBindRequestIds = new Set<string>();
const workspaceBindAbortControllers = new Map<string, AbortController>();
const projectNavigationAbortControllers = new Map<string, AbortController>();
let sourceServerRuntimeInitializeFlight: Promise<SourceServerConnectionManager> | null = null;

function notifyProjectChange(): void {
  void activeServices
    ?.get(IBroadcastService)
    .send({ channel: "state:projects", payload: {} })
    .catch((error) => logger.warn("failed to notify project change", error));
}

/** The fork's service accessor types the Source workspace service as optional; a missing one is an explicit failure, not a crash. */
function requireSourceServerWorkspaceService<
  T extends { readonly sourceServerWorkspaceService?: unknown },
>(services: T): NonNullable<T["sourceServerWorkspaceService"]> {
  const service = services.sourceServerWorkspaceService;
  if (!service) throw new Error("Source Server workspace service unavailable");
  return service as NonNullable<T["sourceServerWorkspaceService"]>;
}

/** Bot only obtains the current Source generation; it owns no connection and creates no logical tab. */
function resolveBotProjectConnection(hostId: string): BotProjectConnection | undefined {
  const serverId = parseRemoteWorkspaceIdentity(
    buildRemoteHostWorkspaceIdentity(hostId, "/"),
  )?.sourceServerId;
  if (!serverId) return undefined;
  const registered = windowRemoteConnectionRegistry.getOnlineSource(serverId);
  if (registered) {
    const services = registered.services;
    return {
      owner: registered.capabilities?.physicalOwner?.() ?? services,
      taskService: createControllerRoutedTaskService(services.get(IZCodeTaskService), {
        kind: "local",
      }),
      modelSelectionService: services.get(IModelSelectionService),
      agentService: services.get(IZCodeAgentService),
      bindWorkspace: async (target) => {
        await registered.capabilities?.bindWorkspaceIdentity?.({
          workspacePath: target.workspacePath,
          stableWorkspaceIdentity: target.workspaceIdentity,
          legacyRouteHint: target.workspaceIdentity,
        });
      },
    };
  }
  const connection = sourceServerConnectionManager?.getOnlineConnection(serverId);
  if (!connection) return undefined;
  return {
    owner: connection.services,
    taskService: createControllerRoutedTaskService(connection.services.zcodeTaskService, {
      kind: "local",
    }),
    modelSelectionService: connection.services.modelSelectionService,
    agentService: connection.services.zcodeAgentService,
    bindWorkspace: async (target) => {
      await requireSourceServerWorkspaceService(connection.services).resolveWorkspace({
        workspacePath: target.workspacePath,
        legacyRouteHint: target.workspaceIdentity,
      });
    },
  };
}

function requireActiveHostApiNetworkTransport(): HostApiNetworkTransport {
  if (!activeHostApiNetworkTransport) {
    // Bug cause: if the Source Server release download falls back to global fetch outside the Host network policy, it bypasses the settings-page proxy.
    throw new Error("Window Host network transport is not initialized");
  }
  return activeHostApiNetworkTransport;
}

async function ensureSourceServerConnectionManager(): Promise<SourceServerConnectionManager> {
  if (sourceServerConnectionManager) return sourceServerConnectionManager;
  if (!sourceServerDirectory) throw new Error("Source Server directory 尚未初始化");
  if (!activeServices) throw new Error("Host services 尚未初始化");
  const directory = sourceServerDirectory;
  const remoteProjects = activeServices.get(IRemoteProjectService);
  sourceServerRuntimeInitializeFlight ??= (async () => {
    await directory.initialize();
    if (hasDisposedHostResources || sourceServerDirectory !== directory) {
      throw new Error("Source Server directory 初始化期间 Host 已释放");
    }
    const manager = new SourceServerConnectionManager({
      directory,
      admitConnection: createRemoteProjectConnectionAdmission(remoteProjects),
      onProjectChange: notifyProjectChange,
      logWarn: (message, error) => logger.warn(message, error),
      sourceServerArtifactPolicy,
      connectServer: (options) =>
        connectDesktopSourceServer(options, {
          resolveServices: (scope) => windowRemoteConnectionRegistry.resolveScopedServices(scope),
          getBots: () => activeServices?.getOptional(IBotsService),
          readDynamicWorkflowMode: async () =>
            (await activeServices?.get(ISettingService).get())?.dynamicWorkflowMode,
          onModeSyncError: (error) =>
            logger.warn("remote dynamic workflow user mode push failed", error),
        }),
    });
    sourceServerConnectionManager = manager;
    return manager;
  })().finally(() => {
    sourceServerRuntimeInitializeFlight = null;
  });
  return await sourceServerRuntimeInitializeFlight;
}
/** Resource telemetry subscriptions for the local host services; remote connection subscriptions are held by each connection handle. */
let activeLocalResourceTelemetry: IDisposable | null = null;
// Resource-manager sampling runs only once per request from main; the Host keeps no periodic timer.
const hostResourceUsageResponder = createHostResourceUsageResponder({
  getAgentService: () => activeServices?.getOptional(IZCodeAgentService),
  postMessage: (message) => parentPort?.postMessage(message),
});
let activeSessionRealtimePort: ReturnType<typeof createTaskRealtimeBridgeForHostInit> = null;
let hasDisposedHostResources = false;
let disposeHostResourcesInFlight: Promise<HostShutdownResult> | null = null;

async function disposeHostRemoteConnection(connection: HostRemoteConnection): Promise<void> {
  connection.dispose();
}

async function createWindowRemoteConnectionHandle(params: {
  target: RemoteTarget;
  membershipIntent?: "add" | "retain";
  existingSourceServerId?: string;
  remoteAssets: RemoteAssetDirs;
  signal: AbortSignal;
  confirmSourceServerInstall?: boolean;
}): Promise<WindowRemoteConnectionHandle<ServiceCollection, HostRemoteConnectionCapabilities>> {
  if (!activeServices) throw new Error("Local Host services are not initialized.");
  const clientConfigService = activeServices.get(IClientConfigService);
  if (params.signal.aborted) {
    throw new Error("远程连接已取消");
  }
  const closeListeners = new Set<(event: WindowRemoteConnectionCloseEvent) => void>();
  const reconnectListeners = new Set<() => void>();
  let topicResourceRelay: ReturnType<typeof createWindowTopicResourceRelay> | undefined;
  const notifyClose = (event: WindowRemoteConnectionCloseEvent) => {
    topicResourceRelay?.dispose();
    for (const listener of closeListeners) {
      listener(event);
    }
  };
  let connection: HostRemoteConnection;
  let managedProfile: import("@zcode/shared").ConnectionProfile | undefined;
  let reusedConnectionTarget: RemoteTarget | undefined;
  let managerStateSubscription: { dispose(): void } | undefined;
  let managerConnectionInvalidatedSubscription: { dispose(): void } | undefined;
  let managerReconnectSubscription: { dispose(): void } | undefined;
  let services: ServiceCollection;
  let resourceTelemetry: IDisposable | undefined;
  const refreshResourceTelemetry = () => {
    resourceTelemetry?.dispose();
    // A Source reconnect replaces services; telemetry must also release the old subscription and attach to the new generation's proxy, to avoid silently dropping samples after reconnect.
    resourceTelemetry = registerHostServiceResourceTelemetry({
      services,
      postMessage: (message) => parentPort?.postMessage(message),
      runtimeSurface: "remote",
      // SSH/WSL/Docker also reuse compatible older Sources; every Server must declare the capability before it subscribes to new events.
      telemetrySupported: connection.serverInfo.capabilities.processResourceTelemetry === true,
      remoteConversationTelemetrySupported:
        connection.serverInfo.capabilities.remoteConversationTelemetry === true,
      environmentKey: resolveResourceTelemetryEnvironmentKey(
        params.target,
        connection.serverInfo.serverId,
      ),
      onError: (error) => logger.warn("remote resource telemetry subscription failed", error),
    });
  };
  let lastNotifiedRecoveryAttempt = 0;
  let disposed = false;
  let sourceClosed = false;
  let projectSubscription: { dispose(): void } | undefined;
  const detachOwnSourceSettings = () => {
    const sourceId = connection?.serverInfo.serverId;
    if (!sourceId || params.target.kind !== "server") return;
    const current = windowRemoteConnectionRegistry.getOnlineSource(sourceId);
    if (!current || current.services === services)
      windowHostAttachmentRegistry.detachSourceSettingsAttachments(sourceId);
  };
  if (params.target.kind === "server") {
    if (params.existingSourceServerId) throw new Error("project.host-offline");
    if (!activeServices) throw new Error("Host services 尚未初始化");
    const admission = await prepareRemoteServerConnection({
      service: activeServices.get(IRemoteProjectService),
      credentials: activeServices.get(ICredentialService),
      target: params.target,
      intent: params.membershipIntent ?? "add",
    });
    params.signal.throwIfAborted();
    topicResourceRelay = createWindowTopicResourceRelay({
      // Pin to the physical Source connection's agent service: `services` is reassigned on each reconnect generation.
      getPeerAgentService: () => connection?.services.zcodeAgentService,
      resolveServices: (scope) => windowRemoteConnectionRegistry.resolveScopedServices(scope),
      getBots: () => activeServices?.getOptional(IBotsService),
    });
    try {
      connection = await connectServerRemote(admission.target, {
        signal: params.signal,
        fetchImpl: requireActiveHostApiNetworkTransport().fetch,
        commitMembership: admission.commit,
        topicResourceChannel: topicResourceRelay.channel,
        onClose: ({ code, reason }) => {
          sourceClosed = true;
          detachOwnSourceSettings();
          notifyClose({ exitCode: code, signal: null, ...(reason ? { error: reason } : {}) });
        },
      });
    } catch (error) {
      topicResourceRelay.dispose();
      throw error;
    }
  } else {
    if (!sourceServerDirectory) {
      throw new Error("Source Server manager 尚未初始化");
    }
    const manager = await ensureSourceServerConnectionManager();
    const existingProfile = params.existingSourceServerId
      ? (await sourceServerDirectory.snapshot()).profiles.find(
          (item) => item.sourceServerId === params.existingSourceServerId,
        )
      : undefined;
    const existingConnection = params.existingSourceServerId
      ? manager.getOnlineConnection(params.existingSourceServerId)
      : undefined;
    if (params.existingSourceServerId && (!existingProfile || !existingConnection))
      throw new Error("project.host-offline");
    const { profile, connection: managed } =
      existingProfile && existingConnection
        ? { profile: existingProfile, connection: existingConnection }
        : await connectSourceServerTarget(sourceServerDirectory, manager, {
            membershipIntent: params.membershipIntent,
            target: params.target,
            allowInstall: params.confirmSourceServerInstall === true,
            resolveRelease: async (probe, target, options) =>
              await resolveSourceServerReleaseAsset(
                probe,
                params.remoteAssets,
                target,
                {
                  fetch: requireActiveHostApiNetworkTransport().fetch,
                },
                options,
              ),
            context: {
              signal: params.signal,
              onLog: (event) => {
                const progress =
                  event.progress == null
                    ? ""
                    : ` ${(Math.max(0, Math.min(1, event.progress)) * 100).toFixed(1)}%`;
                const message =
                  event.progress == null || event.message.startsWith("upload progress:")
                    ? `[source-server:${event.phase}] ${event.message}`
                    : `[source-server:${event.phase}] upload progress (${event.message}):${progress}`;
                remoteConnectionProgressContext.report(event.level ?? "info", [message]);
              },
            },
          });
    managedProfile = profile;
    reusedConnectionTarget = managed.reusedConnectionTarget;
    const sourceDirectorySnapshot = await sourceServerDirectory.snapshot();
    for (const server of sourceDirectorySnapshot.servers) {
      sourceServerDisplayNameById.set(server.sourceServerId, server.displayName);
    }
    managerStateSubscription = manager.onDidChangeState((state) => {
      if (state.profileId !== profile.profileId) return;
      if (state.state === "online") {
        lastNotifiedRecoveryAttempt = 0;
        return;
      }
      const closeEvent = createSourceServerRecoveryCloseEvent(state);
      if (!closeEvent) return;
      if (state.state === "retrying" && state.recoveryAttempt === lastNotifiedRecoveryAttempt) {
        return;
      }
      if (state.state === "retrying") {
        lastNotifiedRecoveryAttempt = state.recoveryAttempt ?? lastNotifiedRecoveryAttempt;
      }
      notifyClose(closeEvent);
    });
    connection = {
      serverInfo: managed.serverInfo,
      services: managed.services,
      dispose() {
        // Bug cause: a Window registry handle is a logical/attachment lease, not the owner of a Source connection.
        // If an old entry is cancelled or recovers late and calls manager.disconnect, it would tear down the Source the new entry is sharing.
        // The real physical connection is reclaimed by SourceServerConnectionManager on explicit disconnect or Host shutdown.
      },
    };
    managerConnectionInvalidatedSubscription = manager.onDidInvalidateConnection((event) => {
      if (event.sourceServerId !== managed.sourceServerId || disposed) return;
      // Bug cause: when the physical Source connection is updated or its current Profile is deleted, if the Registry is not notified per Source first,
      // existing logical workspaces would keep holding invalid services while reporting online.
      // Only the explicitly listed reasons are recoverable: an update, or a restart of the remote service, reconnects with a new generation. Deleting the current Profile
      // is an explicit user disconnect and must publish a terminal close; any future reason is non-recoverable by default and must be declared here explicitly.
      notifyClose({
        exitCode: null,
        signal: null,
        recoverable: event.reason === "update" || event.reason === "restart",
      });
    });
    managerReconnectSubscription = manager.onDidReconnect((reconnected) => {
      if (reconnected.sourceServerId !== managed.sourceServerId || disposed) return;
      connection = {
        serverInfo: reconnected.serverInfo,
        services: reconnected.services,
        dispose() {
          // Same as above: release only the current wrapper's subscription, without closing the shared Source across leases.
        },
      };
      services = createServerRemoteWorkspaceServiceCollection({
        clientConfigService,
        connectionServices: reconnected.services,
        virtualProjects: reconnected.serverInfo.capabilities.virtualProjects,
        serverId: reconnected.serverInfo.serverId,
        sourceServices: activeServices ?? undefined,
        targetKind: params.target.kind,
      });
      refreshResourceTelemetry();
      lastNotifiedRecoveryAttempt = 0;
      for (const listener of reconnectListeners) listener();
    });
  }

  if (params.signal.aborted) {
    topicResourceRelay?.dispose();
    await disposeHostRemoteConnection(connection);
    throw new Error("远程连接已取消");
  }

  services = createServerRemoteWorkspaceServiceCollection({
    clientConfigService,
    connectionServices: connection.services,
    virtualProjects: connection.serverInfo.capabilities.virtualProjects,
    serverId: connection.serverInfo.serverId,
    targetKind: params.target.kind,
    sourceServices: activeServices ?? undefined,
  });
  if (params.target.kind === "server") {
    projectSubscription = connection.services.broadcastService.onMessage((event) => {
      if (!disposed && !sourceClosed && event.channel === "state:projects") notifyProjectChange();
    });
  }
  refreshResourceTelemetry();
  // The desktop attachment uses the Host loopback Range data plane for remote media; services are replaced with each Source reconnect,
  // so the factory fetches the current file service at call time. Direct server connections keep the renderer inline read.
  const remoteMediaPreviewFactory =
    params.target.kind === "server" || !remoteMediaRangePreviewEnabled
      ? undefined
      : (scope: Extract<WindowHostAttachmentScope, { kind: "remote" }>) =>
          createRemoteMediaPreviewProxy({
            fileService: services.get(IFileService),
            logger: {
              debug: (message, metadata) => {
                if (process.env.NODE_ENV !== "production") logger.info(message, metadata);
              },
              warn: (message, metadata) => logger.warn(message, metadata),
            },
            scope,
            requestLimiter: hostRemoteMediaRequestLimiter,
          });

  return {
    ...(reusedConnectionTarget ? { reusedConnectionTarget } : {}),
    get services() {
      return services;
    },
    capabilities: {
      sourceServerId: connection.serverInfo.serverId,
      physicalOwner: () => connection.services,
      ...(remoteMediaPreviewFactory ? { remoteMediaPreviewFactory } : {}),
      persistentSourceConnection: true,
      ...(managedProfile ? { profileId: managedProfile.profileId } : {}),
      ...(managedProfile
        ? {
            promptAttachmentTransferFactory: (
              scope: Extract<WindowHostAttachmentScope, { kind: "remote" }>,
            ) => {
              if (!sourceServerConnectionManager) throw new Error("Source Server is unavailable");
              return createRemotePromptAttachmentTransferService(
                sourceServerConnectionManager.getFileTransfer(connection.serverInfo.serverId),
                {
                  scope,
                  onJanitorError: (error) => logger.warn("remote attachment janitor failed", error),
                },
              );
            },
          }
        : {}),
      ...(managedProfile && sourceServerDirectory
        ? {
            bindWorkspaceIdentity: async (input) => {
              input.signal?.throwIfAborted();
              const currentRouteHint = buildRemoteWorkspaceIdentity(
                input.workspacePath,
                params.target,
              );
              const legacyRouteHint = await sourceServerDirectory!.resolveLegacyWorkspaceIdentity({
                profileId: managedProfile!.profileId,
                workspacePath: input.workspacePath,
                fallback: input.legacyRouteHint ?? currentRouteHint,
              });
              input.signal?.throwIfAborted();
              await requireSourceServerWorkspaceService(connection.services).resolveWorkspace({
                workspacePath: input.workspacePath,
                legacyRouteHint,
              });
            },
          }
        : {
            bindWorkspaceIdentity: async (input) => {
              await requireSourceServerWorkspaceService(connection.services).resolveWorkspace({
                workspacePath: input.workspacePath,
              });
            },
          }),
      ...(managedProfile && sourceServerDirectory
        ? {
            recordWorkspaceOpen: async (input) => {
              await sourceServerDirectory?.recordWorkspaceOpen({
                profileId: managedProfile!.profileId,
                sourceServerId: connection.serverInfo.serverId,
                ...input,
              });
            },
          }
        : {}),
    },
    onDidClose(listener) {
      closeListeners.add(listener);
      return { dispose: () => closeListeners.delete(listener) };
    },
    onDidReconnect(listener) {
      reconnectListeners.add(listener);
      return { dispose: () => reconnectListeners.delete(listener) };
    },
    async dispose() {
      if (disposed) {
        return;
      }
      disposed = true;
      detachOwnSourceSettings();
      topicResourceRelay?.dispose();
      closeListeners.clear();
      reconnectListeners.clear();
      managerStateSubscription?.dispose();
      managerConnectionInvalidatedSubscription?.dispose();
      managerReconnectSubscription?.dispose();
      projectSubscription?.dispose();
      resourceTelemetry?.dispose();
      await disposeHostRemoteConnection(connection);
    },
  };
}

// Remote identity registration for project-tree and pre-send directory resolution, deduplicated per physical connection (see createRemoteIdentityRegistrationCache).
// Registry paths carry the Host directory's legacy hint, Manager paths do not; the two are cached separately, and each path's first registration request stays unchanged.
// Opening a workspace (prepareWorkspaceIdentity) does not go through here; opening still lazily merges old variants per R3 §9.2.
const registryProjectIdentityRegistrations = createRemoteIdentityRegistrationCache();
const managerProjectIdentityRegistrations = createRemoteIdentityRegistrationCache();

const windowRemoteConnectionRegistry = createWindowRemoteConnectionRegistry<
  ServiceCollection,
  HostRemoteConnectionCapabilities
>({
  connect: (request) => createWindowRemoteConnectionHandle(request),
  createId: randomUUID,
  onConnectionChanged: notifyProjectChange,
  resolveSourceServerId: (handle) => handle.capabilities?.sourceServerId,
  shouldKeepConnectionAlive: (handle) => handle.capabilities?.persistentSourceConnection === true,
  prepareWorkspaceIdentity: async (handle, input) => {
    // The workspace step of the connecting progress is driven by these [source-server:workspace] lines.
    remoteConnectionProgressContext.report("info", [
      `[source-server:workspace] Preparing ${input.workspacePath}`,
    ]);
    try {
      await prepareRemoteWorkspaceIdentity(
        handle.services.get(IFileService),
        input,
        handle.capabilities?.bindWorkspaceIdentity,
      );
    } catch (error) {
      // A caller abort is a cancellation, not a folder failure, so it does not appear as a workspace error line.
      if (!input.signal?.aborted) {
        remoteConnectionProgressContext.report("error", [
          `[source-server:workspace] ${error instanceof Error ? error.message : String(error)}`,
        ]);
      }
      throw error;
    }
  },
  releaseWorkspace: async (services, context) => {
    await services.get(IZCodeTaskService).releaseWorkspacePreparation({
      workspacePath: context.workspacePath,
      ...(context.workspaceIdentity ? { workspaceIdentity: context.workspaceIdentity } : {}),
      provider: "glm",
    });
    logger.info(
      `released WSL workspace runtime, workspaceKey=${context.workspaceIdentity?.trim() || context.workspacePath}`,
    );
  },
  onWorkspaceReleaseError: (context, error) => {
    logger.warn(
      `failed to release WSL workspace runtime, workspaceKey=${context.workspaceIdentity?.trim() || context.workspacePath}`,
      error,
    );
  },
  onSessionClosed: (event) => {
    // When a logical session is offline, the attachment still holds the old services/subscriptions; a later sessionId
    // generation change only releases the transport and cannot find those ports by the old ID. The Host closes all clientModes centrally at the point of invalidation.
    windowHostAttachmentRegistry.detachRemoteSessionAttachments(event.remoteSessionId);
    const session = windowRemoteConnectionRegistry.getSession(event.remoteSessionId);
    if (session?.workspacePath && session.workspaceIdentity) {
      windowHostControllerRuntime.disconnectSource({
        kind: "remote",
        ...(session.sourceServerId ? { sourceServerId: session.sourceServerId } : {}),
        remoteSessionId: event.remoteSessionId,
        workspacePath: session.workspacePath,
        workspaceIdentity: session.workspaceIdentity,
      });
    }
    parentPort?.postMessage({
      type: HostResponseTypes.RemoteWorkspaceClosed,
      remoteSessionId: event.remoteSessionId,
      reason: "connection-closed",
      exitCode: event.exitCode,
      signal: event.signal,
      ...(event.recoverable !== undefined ? { recoverable: event.recoverable } : {}),
      ...(event.error ? { error: event.error } : {}),
      ...(event.recoveryAttempt ? { recoveryAttempt: event.recoveryAttempt } : {}),
      ...(event.recoveryLimit ? { recoveryLimit: event.recoveryLimit } : {}),
      ...(event.recoveryBudgetExhausted !== undefined
        ? { recoveryBudgetExhausted: event.recoveryBudgetExhausted }
        : {}),
      ...(event.reasonCode ? { reasonCode: event.reasonCode } : {}),
      ...(event.retryable !== undefined ? { retryable: event.retryable } : {}),
    });
    logWindowHostTopology("remote-connection-closed");
  },
  onSessionReconnected: async ({
    previous,
    current,
    services: currentServices,
    isCurrent,
    commit,
  }) => {
    if (
      !previous.workspacePath ||
      !previous.workspaceIdentity ||
      !current.workspacePath ||
      !current.workspaceIdentity
    ) {
      throw new Error("Source 重连换代缺少 workspace scope");
    }
    const previousScope = {
      kind: "remote" as const,
      ...(previous.sourceServerId ? { sourceServerId: previous.sourceServerId } : {}),
      remoteSessionId: previous.remoteSessionId,
      workspacePath: previous.workspacePath,
      workspaceIdentity: previous.workspaceIdentity,
    };
    const currentScope = {
      kind: "remote" as const,
      ...(current.sourceServerId ? { sourceServerId: current.sourceServerId } : {}),
      ...(current.sourceServerId && sourceServerDisplayNameById.get(current.sourceServerId)
        ? {
            serverDisplayName: sourceServerDisplayNameById.get(current.sourceServerId),
          }
        : {}),
      remoteSessionId: current.remoteSessionId,
      workspacePath: current.workspacePath,
      workspaceIdentity: current.workspaceIdentity,
    };
    await windowHostControllerRuntime.replaceDisconnectedSource(
      previousScope,
      {
        scope: currentScope,
        taskService: currentServices.get(IZCodeTaskService),
        agentService: currentServices.getOptional(IZCodeAgentService),
        sourceAvailability: "online",
      },
      {
        canCommit: isCurrent,
        rollbackOnFailure: true,
      },
    );
    if (!commit()) {
      throw new Error("Source 重连换代在 Controller 提交后失去 Registry owner");
    }
    try {
      parentPort?.postMessage({
        type: HostResponseTypes.RemoteWorkspaceReconnected,
        previousRemoteSessionId: previous.remoteSessionId,
        descriptor: {
          ...(current.sourceServerId ? { sourceServerId: current.sourceServerId } : {}),
          remoteSessionId: current.remoteSessionId,
          target: current.target,
          workspacePath: current.workspacePath,
          workspaceIdentity: current.workspaceIdentity,
          generation: current.generation,
        },
      });
    } catch (error) {
      // Once the Controller has committed the new generation, the Registry must not roll back; a failed parentPort means the Window Host–Main process channel is shutting down,
      // so the existing Host shutdown reclaims all owners.
      logger.error("failed to publish committed remote workspace replacement", error);
    }
    logWindowHostTopology("remote-connection-reconnected");
  },
  onSessionReconnectError: (error) => {
    logger.warn("failed to replace Source Server logical sessions after reconnect", error);
  },
});

const windowHostControllerRuntime = createWindowHostControllerRuntime({
  onRunStarted: (run) =>
    parentPort?.postMessage({
      type: HostResponseTypes.Broadcast,
      message: { channel: "mobile-push:run", payload: run },
    }),
  onNotification: (event) =>
    parentPort?.postMessage({
      type: HostResponseTypes.Broadcast,
      message: { channel: "mobile-push:event", payload: event },
    }),
  createId: randomUUID,
  readHostTaskList: (query) => {
    if (!activeServices) throw new Error("Window Host services unavailable");
    return activeServices.get(IZCodeTaskService).listTaskList(query);
  },
  onSourceError: (scope, operation, error) => {
    logger.warn(
      `window Controller source ${operation} failed, scope=${scope.kind}, workspaceKey=${scope.workspaceIdentity?.trim() || scope.workspacePath}`,
      error,
    );
  },
  resolveSource: (scope) => {
    const remoteSession = windowRemoteConnectionRegistry.findSessionForWorkspace(scope);
    if (remoteSession?.workspacePath && remoteSession.workspaceIdentity) {
      const controllerScope = {
        kind: "remote" as const,
        ...(remoteSession.sourceServerId ? { sourceServerId: remoteSession.sourceServerId } : {}),
        ...(remoteSession.sourceServerId &&
        sourceServerDisplayNameById.get(remoteSession.sourceServerId)
          ? {
              serverDisplayName: sourceServerDisplayNameById.get(remoteSession.sourceServerId),
            }
          : {}),
        remoteSessionId: remoteSession.remoteSessionId,
        workspacePath: remoteSession.workspacePath,
        workspaceIdentity: remoteSession.workspaceIdentity,
      };
      if (remoteSession.sourceAvailability !== "online") {
        return {
          scope: controllerScope,
          sourceAvailability: "offline" as const,
        };
      }
      const services = windowRemoteConnectionRegistry.resolveScopedServices(controllerScope);
      return {
        scope: controllerScope,
        taskService: services.get(IZCodeTaskService),
        agentService: services.getOptional(IZCodeAgentService),
        sourceAvailability: "online" as const,
      };
    }
    // When the remote history scope is not connected or has been removed, it must never fall back to the local tasks-index.
    if (scope.workspaceIdentity && isRemoteWorkspaceIdentity(scope.workspaceIdentity)) {
      // The project tree does not require opening a workspace tab; list commands may reuse the stable Source's existing physical connection and must not fabricate a logical session.
      const identity = parseRemoteWorkspaceIdentity(scope.workspaceIdentity);
      const connection =
        identity?.kind === "server" &&
        identity.sourceServerId &&
        identity.workspacePath === scope.workspacePath
          ? sourceServerConnectionManager?.getOnlineConnection(identity.sourceServerId)
          : undefined;
      const registered =
        identity?.kind === "server" &&
        identity.sourceServerId &&
        identity.workspacePath === scope.workspacePath
          ? windowRemoteConnectionRegistry.getOnlineSource(identity.sourceServerId)
          : undefined;
      if (identity?.kind === "server" && identity.sourceServerId && (connection || registered))
        return {
          scope: {
            kind: "remote" as const,
            sourceServerId: identity.sourceServerId,
            workspacePath: scope.workspacePath,
            workspaceIdentity: scope.workspaceIdentity,
          },
          taskService:
            connection?.services.zcodeTaskService ?? registered!.services.get(IZCodeTaskService),
          agentService:
            connection?.services.zcodeAgentService ??
            registered!.services.getOptional(IZCodeAgentService),
          sourceAvailability: "online" as const,
        };
      return null;
    }
    const taskService = activeServices?.getOptional(IZCodeTaskService);
    if (!taskService) {
      return null;
    }
    return {
      scope: {
        kind: "local" as const,
        workspacePath: scope.workspacePath,
        ...(scope.workspaceIdentity ? { workspaceIdentity: scope.workspaceIdentity } : {}),
      },
      taskService,
      agentService: activeServices?.getOptional(IZCodeAgentService),
      sourceAvailability: "online" as const,
    };
  },
});

// The mobile project.readTree overlays live pending interactions; the projection is only listened to and broadcast while a mobile attachment exists.
const webRemoteProjectTreeActivity = createWebRemoteProjectTreeActivityBridge({
  readRows: () => windowHostControllerRuntime.readTaskRows(),
  subscribeRows: (onChange) => windowHostControllerRuntime.subscribeTaskRows(onChange),
  notifyProjectChange,
});

function wireLocalResourceTelemetry(services: ServiceCollection): void {
  activeLocalResourceTelemetry?.dispose();
  activeLocalResourceTelemetry = registerHostServiceResourceTelemetry({
    services,
    postMessage: (message) => parentPort?.postMessage(message),
    runtimeSurface: "local",
    onError: (error) => logger.warn("local resource telemetry subscription failed", error),
  });
}

function disposeLocalResourceTelemetry(): void {
  try {
    activeLocalResourceTelemetry?.dispose();
  } catch {
    // A failure to release resource telemetry must not block the Host's existing shutdown barrier.
  } finally {
    activeLocalResourceTelemetry = null;
  }
}

type ExposedServicePortHandle = {
  server: IChannelServer & { ready(): void };
  dispose(reason?: WindowHostAttachmentDisposeReason): void;
};

function createControllerRoutedTaskService(
  base: IZCodeTaskService,
  attachmentScope: WindowHostAttachmentScope,
): IZCodeTaskService {
  const route = async (
    params: {
      taskId: string;
      workspacePath: string;
      workspaceIdentity?: string;
    },
    mutation:
      | { kind: "pin"; pinned: boolean }
      | { kind: "archive"; archived: boolean }
      | { kind: "delete" }
      | { kind: "mark-read"; expectedUnreadAt?: number }
      | { kind: "mark-unread" },
  ) =>
    windowHostControllerRuntime.service.mutateTask({
      address: await windowHostControllerRuntime.resolveTaskAddress({
        taskId: params.taskId,
        workspacePath: params.workspacePath,
        ...(params.workspaceIdentity ? { workspaceIdentity: params.workspaceIdentity } : {}),
        attachmentScope,
      }),
      mutation,
    });

  return new Proxy(base, {
    get(target, property, receiver) {
      if (property === "setTaskPinned") {
        return async (params: Parameters<IZCodeTaskService["setTaskPinned"]>[0]) => {
          const meta = await route(params, {
            kind: "pin",
            pinned: params.pinned,
          });
          if (!meta) throw new Error("pin mutation 后 task 投影缺失");
          return meta;
        };
      }
      if (property === "archiveTask" || property === "unarchiveTask") {
        return async (
          params:
            | Parameters<IZCodeTaskService["archiveTask"]>[0]
            | Parameters<IZCodeTaskService["unarchiveTask"]>[0],
        ) => {
          const meta = await route(params, {
            kind: "archive",
            archived: property === "archiveTask",
          });
          if (!meta) throw new Error("archive mutation 后 task 投影缺失");
          return meta;
        };
      }
      if (property === "deleteTask") {
        return async (params: Parameters<IZCodeTaskService["deleteTask"]>[0]) => {
          await route(params, { kind: "delete" });
        };
      }
      if (property === "deleteArchivedTasks") {
        return async (params: Parameters<IZCodeTaskService["deleteArchivedTasks"]>[0]) => {
          if (params.taskIds.length === 0) {
            return { deletedTaskIds: [], skippedTaskIds: [], failedTaskIds: [] };
          }
          return windowHostControllerRuntime.service.deleteArchivedTasks({
            address: await windowHostControllerRuntime.resolveTaskAddress({
              workspacePath: params.workspacePath,
              workspaceIdentity: params.workspaceIdentity,
              taskId: params.taskIds[0]!,
              attachmentScope,
              allowMissingTask: true,
            }),
            taskIds: params.taskIds,
          });
        };
      }
      if (property === "deleteArchivedTask") {
        return async (params: Parameters<IZCodeTaskService["deleteArchivedTask"]>[0]) =>
          windowHostControllerRuntime.service.deleteArchivedTask({
            address: await windowHostControllerRuntime.resolveTaskAddress({
              ...params,
              attachmentScope,
              allowMissingTask: true,
            }),
          });
      }
      if (property === "setTaskUnread") {
        return async (params: Parameters<IZCodeTaskService["setTaskUnread"]>[0]) => {
          const meta = await route(
            params,
            params.unread
              ? { kind: "mark-unread" }
              : {
                  kind: "mark-read",
                  ...(params.expectedUnreadAt != null
                    ? { expectedUnreadAt: params.expectedUnreadAt }
                    : {}),
                },
          );
          if (!meta) throw new Error("unread mutation 后 task 投影缺失");
          return meta;
        };
      }
      const value = Reflect.get(target, property, receiver) as unknown;
      if (
        typeof value === "function" &&
        [
          "getBotGroupTaskBlockReason",
          "cancelBotGroupInput",
          "submitBotGroupInput",
          "readBotTopicSummaries",
        ].includes(String(property))
      ) {
        return (params: Record<string, unknown>) =>
          value.call(target, bindBotGroupTaskScope(params, attachmentScope));
      }
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

const terminalOwners = createWindowHostTerminalOwners((error) => {
  logger.warn("failed to dispose mobile terminal owner", error);
});

function exposeServicesOnMessagePort(
  port: Electron.MessagePortMain,
  services: ServiceCollection,
  deferInit: boolean,
  clientMode: ZCodeAgentV4ClientMode = "desktop-continuous",
  attachmentScope: WindowHostAttachmentScope = { kind: "local" },
  capabilities?: HostRemoteConnectionCapabilities,
  terminalOwnerId?: string,
): ExposedServicePortHandle {
  const terminal = services.getOptional(ITerminalService);
  const legacyTerminalScope =
    clientMode === "web-remote-replayable" && terminal && !terminalOwnerId
      ? createTerminalScope(terminal, (error) =>
          logger.warn("failed to dispose mobile attachment terminal", error),
        )
      : undefined;
  const scopedTerminal =
    clientMode === "web-remote-replayable" && terminal
      ? terminalOwnerId
        ? terminalOwners.bind(
            terminalOwnerId,
            attachmentScope.kind === "remote"
              ? `remote:${attachmentScope.remoteSessionId}`
              : "local",
            terminal,
          )
        : legacyTerminalScope!.service
      : undefined;
  const wrappedPort = wrapElectronPort(port);
  const protocol = new MessagePortProtocol(wrappedPort);
  // Remote mode delays sending Initialize: remote connection takes time, and if Initialize were sent at construction,
  // the renderer would issue requests before the channel is registered, causing an "Unknown channel" timeout.
  // Attach mode reuses ready services and must initialize the new RPC MessagePort immediately.
  logger.info(`creating ChannelServer (deferInit=${deferInit})`);
  const rawServer = new ChannelServer(protocol, "host", 1000, deferInit);
  const loggedServer = new LoggingChannelServer(rawServer, logRpc);
  const server = new NetworkTelemetryChannelServer(loggedServer);
  const agentService = services.getOptional(IZCodeAgentService);
  const connectionContext = { connectionId: `host-rpc-${randomUUID()}`, clientMode };
  const connectionScope = agentService
    ? createZCodeAgentConnectionScope(agentService, connectionContext)
    : undefined;
  services.register(IWindowControllerService, windowHostControllerRuntime.service);
  // Fork: every attachment owns unread signals (ownsUnreadSignals defaults to true), so the
  // web-remote-replayable attachment forwards them to the phone sidebar as well. Upstream gates this
  // to the local desktop-continuous attachment; that gate is not ported.
  const controllerAttachment = windowHostControllerRuntime.createAttachmentService();
  const overrides = new Map<string, unknown>([
    [IWindowControllerService.channelName, controllerAttachment],
  ]);
  // A phone can rebuild its Root from any remote workspace; the sidebar organization service still belongs to the controlling side and must not swap databases with the current execution attachment.
  if (
    clientMode === "web-remote-replayable" &&
    attachmentScope.kind === "remote" &&
    activeServices
  ) {
    overrides.set(IProjectService.channelName, activeServices.get(IProjectService));
    overrides.set(IRemoteProjectService.channelName, activeServices.get(IRemoteProjectService));
    services.register(ITaskGroupService, activeServices.get(ITaskGroupService));
    // Quick prompts are owned by the controller Host; mobile reads them through the read-only scope in
    // exposeWindowHostAttachmentServices. Skip when the controller does not expose them.
    const controllerQuickPrompts = activeServices.getOptional(IQuickPromptService);
    if (controllerQuickPrompts) services.register(IQuickPromptService, controllerQuickPrompts);
  }
  // Remote media must choose its data plane by the attachment's clientMode: desktop uses the Host loopback Range, the phone stays inline.
  const remoteMediaPreviewProxy =
    attachmentScope.kind === "remote" && clientMode === "desktop-continuous"
      ? capabilities?.remoteMediaPreviewFactory?.(attachmentScope)
      : undefined;
  if (remoteMediaPreviewProxy) {
    overrides.set(IMediaPreviewService.channelName, remoteMediaPreviewProxy.service);
  }
  // R3's Source-local transfer cannot read the Desktop localPath; cross-machine staging must be injected by the owning
  // Window Host attachment, reusing the current transport. Desktop and phone do not create another runtime or business queue.
  const remotePromptAttachmentTransfer =
    attachmentScope.kind === "remote"
      ? capabilities?.promptAttachmentTransferFactory?.(attachmentScope)
      : undefined;
  const { dispose: disposePromptAttachmentTransfer, ...promptAttachmentService } =
    remotePromptAttachmentTransfer ?? {};
  if (remotePromptAttachmentTransfer) {
    // dispose belongs only to the Host attachment lifecycle and is not exposed as a Renderer RPC.
    overrides.set(IPromptAttachmentTransferService.channelName, promptAttachmentService);
  }
  const taskService = services.getOptional(IZCodeTaskService);
  if (taskService) {
    overrides.set(
      IZCodeTaskService.channelName,
      createControllerRoutedTaskService(taskService, attachmentScope),
    );
  }
  if (connectionScope) {
    overrides.set(IZCodeAgentService.channelName, connectionScope.service);
  }
  const conversationShareService = services.getOptional(IConversationShareService);
  if (conversationShareService) {
    // If the Share service kept a raw Agent, it would bypass the trusted carrier already handshaken on the current MessagePort,
    // and rowsRange would be rejected as an untrusted connection. It must reuse the same attachment connection scope.
    overrides.set(
      IConversationShareService.channelName,
      scopeConversationShareServiceForAttachment(
        conversationShareService,
        clientMode,
        connectionScope?.service,
        connectionContext,
      ),
    );
  }
  if (scopedTerminal) overrides.set(ITerminalService.channelName, scopedTerminal);
  const isWebRemoteAttachment = clientMode === "web-remote-replayable";
  const baseProjectService = isWebRemoteAttachment
    ? ((overrides.get(IProjectService.channelName) as IProjectService | undefined) ??
      services.getOptional(IProjectService))
    : undefined;
  if (baseProjectService) {
    overrides.set(
      IProjectService.channelName,
      webRemoteProjectTreeActivity.decorate(baseProjectService),
    );
  }
  const webRemoteProjectTreeRetention = isWebRemoteAttachment
    ? webRemoteProjectTreeActivity.retain()
    : undefined;
  exposeWindowHostAttachmentServices({
    server,
    services,
    overrides,
    clientMode,
    attachmentScope,
    windowServices: activeServices ?? undefined,
    ...(isWebRemoteAttachment
      ? { decorateWindowProjectService: webRemoteProjectTreeActivity.decorate }
      : {}),
  });
  let disposed = false;
  const flowForwarder = createWindowHostAttachmentFlowForwarder(connectionScope, (state, error) => {
    logger.warn("failed to forward attachment connection flow state", {
      state,
      message: error instanceof Error ? error.message : String(error),
    });
  });
  const flowStateDisposable = protocol.onFlowState((state) => {
    if (disposed) return;
    // MessagePort sideband is already separated from Uint8Array at the protocol layer; here we only serially forward the owning scope's
    // edges to the CLI, and the control object must not specify connectionId.
    void flowForwarder.forward(state).catch(() => {});
  });
  const handle: ExposedServicePortHandle = {
    server,
    dispose(reason) {
      if (disposed) return;
      disposed = true;
      flowStateDisposable.dispose();
      controllerAttachment.dispose();
      legacyTerminalScope?.dispose();
      webRemoteProjectTreeRetention?.dispose();
      void disposePromptAttachmentTransfer?.().catch((error: unknown) => {
        logger.warn("failed to dispose remote attachment transfer", error);
      });
      void remoteMediaPreviewProxy?.dispose().catch((error: unknown) => {
        logger.warn("failed to dispose remote media preview proxy", error);
      });
      // close is queued after all received SAT/DRN; scope.dispose itself idempotently ensures closed again,
      // but a late saturated must never revive the CLI pause state after close.
      void flowForwarder.close(reason);
      rawServer.dispose();
      protocol.disconnect();
    },
  };
  port.once("close", () => handle.dispose());
  logger.info(`service connection ready mode=${clientMode}`);
  return handle;
}

const windowHostAttachmentRegistry = createWindowHostAttachmentRegistry<
  ServiceCollection,
  Electron.MessagePortMain,
  HostRemoteConnectionCapabilities
>({
  resolveScope: (scope: WindowHostAttachmentScope) => {
    if (scope.kind === "local") {
      if (!activeServices) {
        throw new Error("local services 尚未初始化");
      }
      return { services: activeServices, generation: 1 };
    }
    if (scope.kind === "source-settings") {
      const connection = sourceServerConnectionManager?.getOnlineConnection(scope.sourceServerId);
      const registered = windowRemoteConnectionRegistry.getOnlineSource(scope.sourceServerId);
      const configServices = connection?.services ?? registered?.services;
      if (!configServices) {
        throw new Error(`Source Server is offline: ${scope.sourceServerId}`);
      }
      return {
        services: createSourceSettingsServiceCollection(configServices),
        generation:
          sourceServerConnectionManager
            ?.listStates()
            .find((state) => state.sourceServerId === scope.sourceServerId)?.updatedAt ?? 1,
      };
    }
    const session = windowRemoteConnectionRegistry.getSession(scope.remoteSessionId);
    if (!session) {
      throw new Error(`未找到远程 logical session，remoteSessionId=${scope.remoteSessionId}`);
    }
    return {
      services: windowRemoteConnectionRegistry.resolveScopedServices(scope),
      generation: session.generation,
      capabilities: windowRemoteConnectionRegistry.resolveScopedCapabilities(scope),
    };
  },
  expose: ({ port, services, clientMode, scope, capabilities, terminalOwnerId }) =>
    exposeServicesOnMessagePort(
      port,
      services,
      false,
      clientMode,
      scope,
      capabilities,
      terminalOwnerId,
    ),
});

function logWindowHostTopology(reason: string): void {
  const stats = windowRemoteConnectionRegistry.getStats();
  logger.info(
    `window Host topology, reason=${reason}, pid=${process.pid}, connections=${stats.connectionCount}, logicalSessions=${stats.logicalSessionCount}, attachments=${windowHostAttachmentRegistry.size()}`,
  );
}

function disposeAttachedServicePorts(): void {
  terminalOwners.setOwner(null);
  windowHostAttachmentRegistry.dispose();
}

async function disposeHostResources(reason: string): Promise<HostShutdownResult> {
  databaseStartup?.dispose();
  pendingStartupAttachments.clear();
  if (hasDisposedHostResources) {
    return (
      (await disposeHostResourcesInFlight) ?? {
        exitCode: 0,
        failedPhases: [],
        timedOutPhases: [],
      }
    );
  }
  hasDisposedHostResources = true;
  for (const controller of projectNavigationAbortControllers.values()) controller.abort();
  projectNavigationAbortControllers.clear();

  disposeHostResourcesInFlight = (async () => {
    logger.info(`disposing host resources, reason=${reason}`);

    pluginSandboxRegistrationBridge.dispose();
    stopHostNetworkTelemetry();
    hostNetworkCapture.setCaptureId(null);
    hostSelfResourceTelemetry.stop();
    disposeLocalResourceTelemetry();
    disposeAttachedServicePorts();
    windowHostControllerRuntime.dispose();
    for (const key of Array.from(cronRunSubscriptions.keys())) {
      disposeCronRunSubscription(key);
    }
    cronAutomationRepo.close();
    for (const key of Array.from(offPeakRunSubscriptions.keys())) {
      disposeOffPeakRunSubscription(key);
    }
    disposeOffPeakRuntime();
    offPeakTaskRepo.close();

    if (activeSessionRealtimePort) {
      activeSessionRealtimePort.dispose();
      activeSessionRealtimePort = null;
    }

    const servicesToDispose = activeServices;
    activeServices = null;
    // The Registry is the only owner of all remote connections; a release failure must not block the local services from continuing to shut down.
    const shutdownResult = await runHostShutdownPhases(
      [
        {
          name: "remote-registry-dispose",
          run: () => windowRemoteConnectionRegistry.dispose(),
          timeoutMs: 6_000,
        },
        {
          name: "source-server-manager-dispose",
          run: async () => {
            sourceServerConnectionManager?.dispose();
            sourceServerManagementService?.dispose();
            sourceSettingsStateSubscription?.dispose();
            sourceServerConnectionManager = null;
            sourceServerManagementService = null;
            sourceSettingsStateSubscription = null;
            sourceServerDirectory = null;
          },
          timeoutMs: 2_000,
        },
        ...(servicesToDispose
          ? [
              {
                name: "service-dispose",
                run: () => disposeServiceResourcesAndWait(servicesToDispose),
                timeoutMs: 3_500,
              },
            ]
          : []),
      ],
      {
        phaseTimeoutMs: 5_000,
        log: (message, details) => logger.warn(message, details),
      },
    );
    if (shutdownResult.exitCode !== 0) {
      logger.warn("host resource cleanup completed with errors", {
        failedPhases: shutdownResult.failedPhases,
        reason,
        timedOutPhases: shutdownResult.timedOutPhases,
      });
    }
    activeHostApiNetworkTransport = null;
    return shutdownResult;
  })();

  const shutdownResult = await disposeHostResourcesInFlight;
  flushHostE2ECoverage((error) => {
    logger.warn("[e2e-coverage] host coverage flush failed", error);
  });
  return shutdownResult;
}

function disposeHostResourcesBestEffort(reason: string): void {
  if (hasDisposedHostResources) {
    return;
  }
  hasDisposedHostResources = true;

  logger.info(`disposing host resources, reason=${reason}`);
  pluginSandboxRegistrationBridge.dispose();
  stopHostNetworkTelemetry();
  hostNetworkCapture.setCaptureId(null);
  disposeLocalResourceTelemetry();
  disposeAttachedServicePorts();
  windowHostControllerRuntime.dispose();
  for (const key of Array.from(cronRunSubscriptions.keys())) {
    disposeCronRunSubscription(key);
  }
  cronAutomationRepo.close();
  for (const key of Array.from(offPeakRunSubscriptions.keys())) {
    disposeOffPeakRunSubscription(key);
  }
  disposeOffPeakRuntime();
  offPeakTaskRepo.close();
  void windowRemoteConnectionRegistry.dispose();

  if (activeServices) {
    try {
      disposeServiceResources(activeServices);
    } catch (error) {
      logger.error("failed to dispose local services:", error);
    } finally {
      activeServices = null;
      activeHostApiNetworkTransport = null;
    }
  }

  if (activeSessionRealtimePort) {
    activeSessionRealtimePort.dispose();
    activeSessionRealtimePort = null;
  }
}

process.once("SIGTERM", () => {
  void disposeHostResources("SIGTERM").then(
    (result) => process.exit(result.exitCode),
    () => process.exit(1),
  );
});

process.once("SIGINT", () => {
  void disposeHostResources("SIGINT").then(
    (result) => process.exit(result.exitCode),
    () => process.exit(1),
  );
});

process.once("disconnect", () => {
  // Once the parent IPC disappears, no one will send Dispose again; after bounded cleanup completes, the process must exit explicitly to avoid the Host staying resident.
  void disposeHostResources("disconnect").finally(() => process.exit(1));
});

process.once("exit", () => {
  disposeHostResourcesBestEffort("exit");
});

let handlingFatalUncaughtException = false;
process.on(
  "uncaughtException",
  createHostUncaughtExceptionHandler({
    onRecovered: (error, origin) => {
      const memoryUsage = process.memoryUsage();
      logger.warn("contained host allocation failure from native TLS callback", {
        arrayBuffers: memoryUsage.arrayBuffers,
        external: memoryUsage.external,
        heapUsed: memoryUsage.heapUsed,
        message: error.message,
        origin,
        rss: memoryUsage.rss,
      });
    },
    onFatal: (error, origin) => {
      if (handlingFatalUncaughtException) {
        process.exit(1);
      }
      handlingFatalUncaughtException = true;
      logger.error(`uncaughtException origin=${origin}:`, error);
      void disposeHostResources(`uncaughtException:${origin}`).finally(() => process.exit(1));
    },
  }),
);

parentPort.on("message", async (e: Electron.MessageEvent) => {
  const result = parseHostIncomingMessageEvent(e);
  if (!result.success) {
    logger.error("invalid parentPort message:", formatZodError(result.error));
    return;
  }

  const msg = result.data;
  // Assign synchronously before any await: InitLocal and change messages arrive in order on the same port, so the initial value cannot overwrite a newer change.
  if (
    msg.type === HostMessageTypes.InitLocal &&
    msg.locale &&
    !applicationLocaleChangedBeforeInit
  ) {
    applicationLocale = msg.locale;
  }
  if (msg.type === HostMessageTypes.ApplicationLocaleChanged) {
    applicationLocale = msg.locale;
    applicationLocaleChangedBeforeInit = true;
    return;
  }
  if (msg.type === HostMessageTypes.NetworkCapture) {
    hostNetworkCapture.setCaptureId(msg.control.captureId);
    return;
  }
  if (msg.type === HostMessageTypes.OpenWorkspaceInventoryResult) {
    const pending = pendingOpenWorkspaceInventoryRequests.get(msg.requestId);
    if (pending) {
      clearTimeout(pending.timer);
      pendingOpenWorkspaceInventoryRequests.delete(msg.requestId);
      pending.resolve({ available: msg.available, paths: msg.paths });
    }
    return;
  }
  const port = e.ports[0];
  if (msg.type === HostMessageTypes.DatabaseStartupControl) {
    if (msg.control.action === "snapshot") databaseStartup?.coordinator.publish();
    else if (msg.control.action === "retry")
      void databaseStartup?.coordinator.retry(msg.control.attemptId);
    return;
  }

  if (msg.type === HostMessageTypes.PrepareProjectWorkspace) {
    const controller = new AbortController();
    if (projectNavigationAbortControllers.has(msg.requestId)) {
      parentPort.postMessage({
        type: HostResponseTypes.ProjectWorkspacePrepared,
        requestId: msg.requestId,
        result: { ok: false, error: "项目导航 requestId 重复" },
      });
      return;
    }
    projectNavigationAbortControllers.set(msg.requestId, controller);
    try {
      const services = activeServices;
      if (!services || hasDisposedHostResources) throw new Error("Window Host is unavailable");
      const assertHost = () => {
        controller.signal.throwIfAborted();
        if (activeServices !== services || hasDisposedHostResources)
          throw new Error("Window Host changed during project navigation");
      };
      const navigation = createProjectWorkspaceNavigation({
        projectService: services.get(IProjectService),
        remoteProjectService: services.get(IRemoteProjectService),
        readConnectionOwner: (hostId) => resolveBotProjectConnection(hostId)?.owner,
        openRemoteWorkspace: async ({ host, directories, owner, assertCurrent }) => {
          assertHost();
          const serverId = parseRemoteWorkspaceIdentity(
            buildRemoteHostWorkspaceIdentity(host.id, directories.workspacePath),
          )?.sourceServerId;
          if (!serverId || !host.target) throw new Error("project.host-offline");
          // For Manager-only Sources, only register a wrapper for the existing connection; a URL Source must already be online in the Registry.
          const registered = await windowRemoteConnectionRegistry.connectSource({
            target: host.target,
            remoteAssets: {},
            membershipIntent: "retain",
            existingSourceServerId: serverId,
          });
          assertHost();
          if (
            (registered.handle.capabilities?.physicalOwner?.() ?? registered.handle.services) !==
            owner
          )
            throw new Error("project.navigation-stale");
          return windowRemoteConnectionRegistry.openWorkspaceOnSource({
            requestId: msg.requestId,
            sourceServerId: serverId,
            workspacePath: directories.workspacePath,
            workspaceIdentity: directories.workspaceIdentity,
            workspacePurpose: directories.projectId ? "project" : "conversation",
            assertCurrent: async () => {
              assertHost();
              await assertCurrent();
              assertHost();
            },
          });
        },
      });
      const value = await navigation.prepare({
        projectId: msg.projectId,
        hostId: msg.hostId,
        draftId: msg.draftId,
        reuseDraft: msg.reuseDraft,
        ...(msg.task ? { task: msg.task } : {}),
      });
      assertHost();
      parentPort.postMessage({
        type: HostResponseTypes.ProjectWorkspacePrepared,
        requestId: msg.requestId,
        result: { ok: true, value },
      });
    } catch (error) {
      parentPort.postMessage({
        type: HostResponseTypes.ProjectWorkspacePrepared,
        requestId: msg.requestId,
        result: { ok: false, error: error instanceof Error ? error.message : String(error) },
      });
    } finally {
      if (projectNavigationAbortControllers.get(msg.requestId) === controller)
        projectNavigationAbortControllers.delete(msg.requestId);
    }
    return;
  }

  if (msg.type === HostMessageTypes.CuaPipFocusChanged) {
    const service = activeServices?.getOptional(ICuaPipSessionService);
    if (service) {
      void service.publishFocus(msg.event);
    } else {
      // When no service is available, the message used to be silently dropped, so focus-changed vanished from the pipeline
      // (0 entries in dev, 92 in the same period for the packaged build). Logging this makes it possible to separate "main did not send" from
      // "host received it but the service was not registered".
      logger.warn("[cua-pip-session] focus event dropped: service unavailable");
    }
    return;
  }

  if (msg.type === HostMessageTypes.ResourceUsageSnapshotRequest) {
    void hostResourceUsageResponder.handleRequest(msg);
    return;
  }
  if (msg.type === HostMessageTypes.ResourceUsageSnapshotCancel) {
    hostResourceUsageResponder.cancelRequest(msg.requestId);
    return;
  }

  if (msg.type === HostMessageTypes.ProviderProvisioningLaneResult) {
    hostProviderProvisioningStatus.handleResult(msg);
    return;
  }

  if (msg.type === HostMessageTypes.FeedbackLogArchiveResult) {
    const pending = pendingFeedbackLogArchiveRequests.get(msg.requestId);
    if (!pending) {
      return;
    }
    pendingFeedbackLogArchiveRequests.delete(msg.requestId);
    if (msg.ok && msg.path && typeof msg.size === "number") {
      pending.onProgress?.({ processedBytes: msg.size, totalBytes: msg.size });
      pending.resolve({ path: msg.path, size: msg.size });
      return;
    }
    pending.reject(new Error(msg.error ?? "反馈日志归档创建失败"));
    return;
  }

  if (msg.type === HostMessageTypes.LocalMediaPreviewPathAuthorizeResult) {
    const pending = pendingLocalMediaPreviewPathAuthorizations.get(msg.requestId);
    if (!pending) return;
    pendingLocalMediaPreviewPathAuthorizations.delete(msg.requestId);
    if (msg.ok && msg.path) {
      logger.info("local media preview path authorization OK");
      pending.resolve(msg.path);
    } else {
      pending.reject(new Error(msg.error ?? "本地视频预览路径授权失败"));
    }
    return;
  }

  if (msg.type === HostMessageTypes.PluginSandboxRegisterResult) {
    pluginSandboxRegistrationBridge.accept(msg);
    return;
  }

  if (msg.type === HostMessageTypes.CronRun) {
    if (databaseStartup?.coordinator.snapshot.phase !== "ready") {
      parentPort.postMessage({
        type: HostResponseTypes.CronRunResult,
        runId: msg.runId,
        ok: false,
        error: "Local database startup is not ready",
        failureKind: "transient",
      });
      return;
    }
    void (async () => {
      try {
        const dispatchResult = await dispatchCronRun({
          ...msg,
          mode: msg.mode as ZCodeTaskMode | undefined,
        });
        parentPort.postMessage({
          type: HostResponseTypes.CronRunResult,
          runId: msg.runId,
          ok: true,
          ...dispatchResult,
        });
      } catch (error) {
        parentPort.postMessage({
          type: HostResponseTypes.CronRunResult,
          runId: msg.runId,
          ok: false,
          error: error instanceof Error ? error.message : String(error),
          failureKind: "transient",
        });
      }
    })();
    return;
  }

  if (msg.type === HostMessageTypes.OffPeakRun) {
    if (databaseStartup?.coordinator.snapshot.phase !== "ready") {
      parentPort.postMessage({
        type: HostResponseTypes.OffPeakRunResult,
        offPeakTaskId: msg.offPeakTaskId,
        ok: false,
        error: "Local database startup is not ready",
        failureKind: "transient",
      });
      return;
    }
    void (async () => {
      try {
        const dispatchResult = await dispatchOffPeakRun(msg);
        parentPort.postMessage({
          type: HostResponseTypes.OffPeakRunResult,
          offPeakTaskId: msg.offPeakTaskId,
          ok: true,
          ...dispatchResult,
        });
      } catch (error) {
        parentPort.postMessage({
          type: HostResponseTypes.OffPeakRunResult,
          offPeakTaskId: msg.offPeakTaskId,
          ok: false,
          error: error instanceof Error ? error.message : String(error),
          // Deterministic model/credential configuration errors will not heal on retry; hand them to the scheduler to mark as failed,
          // while unknown and lifecycle errors keep the original transient backoff semantics.
          failureKind: error instanceof OffPeakPermanentDispatchError ? "permanent" : "transient",
        });
      }
    })();
    return;
  }

  if (msg.type === HostMessageTypes.BrowserExecuteResult) {
    // main executes the browser command via WebContentsView+CDP, and the response is matched back to the bridge's pending entry by requestId.
    void browserControlMainBridge.handleResult({
      requestId: msg.requestId,
      result: msg.result,
    });
    return;
  }

  if (msg.type === HostMessageTypes.Dispose) {
    // Main process cleanup notification (on window close / app quit)
    // This must wait for unified resource cleanup to finish (including async write-back) before the process exits; main still has a kill timer as a fallback.
    const result = await disposeHostResources("parent dispose");
    process.exit(result.exitCode);
    return;
  }

  if (msg.type === HostMessageTypes.Broadcast) {
    return;
  }

  if (msg.type === HostMessageTypes.SessionMessageDeliver) {
    const zcodeTaskService = activeServices?.getOptional(IZCodeTaskService);
    if (!zcodeTaskService) {
      parentPort.postMessage({
        type: HostResponseTypes.SessionMessageDeliverResult,
        result: {
          error: "ZCode task service is not initialized.",
          messageId: msg.request.messageId,
          requestId: msg.request.requestId,
          sessionId: msg.request.fromSessionId,
          status: "failed",
        },
      });
      return;
    }

    void zcodeTaskService
      .deliverSessionMessage(msg.request)
      .then((deliveryResult) => {
        parentPort.postMessage({
          type: HostResponseTypes.SessionMessageDeliverResult,
          result: deliveryResult,
        });
      })
      .catch((error) => {
        parentPort.postMessage({
          type: HostResponseTypes.SessionMessageDeliverResult,
          result: {
            error: error instanceof Error ? error.message : String(error),
            messageId: msg.request.messageId,
            requestId: msg.request.requestId,
            sessionId: msg.request.fromSessionId,
            status: "failed",
          },
        });
      });
    return;
  }

  if (msg.type === HostMessageTypes.SessionMessageDeliveryResult) {
    const zcodeTaskService = activeServices?.getOptional(IZCodeTaskService);
    if (!zcodeTaskService) {
      logger.warn("session message delivery result received before ZCode task service initialized");
      return;
    }
    void zcodeTaskService.sendSessionMessageDeliveryResult(msg.result).catch((error) => {
      logger.warn("failed to forward session message delivery result:", error);
    });
    return;
  }

  if (msg.type === HostMessageTypes.ProviderProvisioningExecute) {
    const session = windowRemoteConnectionRegistry.getSession(msg.remoteSessionId);
    if (
      !session ||
      !session.workspaceIdentity ||
      buildRemoteEnvironmentKey(session.target) !== msg.environmentKey
    ) {
      parentPort.postMessage({
        type: HostResponseTypes.ProviderProvisioningExecutionResult,
        requestId: msg.requestId,
        environmentKey: msg.environmentKey,
        status: "failed",
        error: "Remote Environment registration 已失效",
        errorCode: "session-unavailable",
      });
      return;
    }
    const scope = {
      kind: "remote",
      remoteSessionId: session.remoteSessionId,
      workspacePath: session.workspacePath ?? "/",
      workspaceIdentity: session.workspaceIdentity,
    } as const;
    void Promise.resolve()
      .then(() =>
        (() => {
          const provisioningService = getRemoteProviderProvisioningExecutor(
            windowRemoteConnectionRegistry.resolveScopedServices(scope),
          );
          if (!provisioningService) {
            throw new Error("Remote Environment 不支持 Provider Provisioning");
          }
          return provisioningService.syncLocalToRemote();
        })(),
      )
      .then((result) => {
        parentPort.postMessage({
          type: HostResponseTypes.ProviderProvisioningExecutionResult,
          requestId: msg.requestId,
          environmentKey: msg.environmentKey,
          status: result.status,
          ...(result.errorMessage ? { error: result.errorMessage } : {}),
          ...(result.errorCode ? { errorCode: result.errorCode } : {}),
        });
      })
      .catch((error: unknown) => {
        parentPort.postMessage({
          type: HostResponseTypes.ProviderProvisioningExecutionResult,
          requestId: msg.requestId,
          environmentKey: msg.environmentKey,
          status: "failed",
          error: error instanceof Error ? error.message : String(error),
          errorCode: "host-execution-failed",
        });
      });
    return;
  }

  if (msg.type === HostMessageTypes.ConnectRemoteWorkspace) {
    const workspacePath =
      msg.workspacePath ??
      (msg.target.kind === "server" ? msg.target.workspacePath?.trim() || "/" : "/");
    const workspaceIdentity =
      msg.workspaceIdentity ?? buildRemoteWorkspaceIdentity(workspacePath, msg.target);
    logger.info(
      `connecting window-scoped remote source, requestId=${msg.requestId}, target=${formatRemoteTargetForLog(msg.target)}`,
    );
    void remoteConnectionProgressContext
      .run(msg.requestId, () =>
        windowRemoteConnectionRegistry.connect({
          requestId: msg.requestId,
          target: msg.target,
          remoteAssets: msg.remoteAssets,
          workspacePath,
          workspaceIdentity,
          ...(msg.confirmSourceServerInstall ? { confirmSourceServerInstall: true } : {}),
        }),
      )
      .then(async (descriptor) => {
        const replacedOfflineSessions = windowRemoteConnectionRegistry
          .listSessions()
          .filter(
            (session) =>
              session.remoteSessionId !== descriptor.remoteSessionId &&
              session.state === "disconnected" &&
              session.workspacePath === descriptor.workspacePath &&
              session.workspaceIdentity === descriptor.workspaceIdentity,
          );
        for (const replaced of replacedOfflineSessions) {
          if (replaced.workspacePath && replaced.workspaceIdentity) {
            const previousScope = {
              kind: "remote",
              ...(replaced.sourceServerId ? { sourceServerId: replaced.sourceServerId } : {}),
              remoteSessionId: replaced.remoteSessionId,
              workspacePath: replaced.workspacePath,
              workspaceIdentity: replaced.workspaceIdentity,
            } as const;
            const nextScope = {
              kind: "remote",
              ...(descriptor.sourceServerId ? { sourceServerId: descriptor.sourceServerId } : {}),
              remoteSessionId: descriptor.remoteSessionId,
              workspacePath: replaced.workspacePath,
              workspaceIdentity: replaced.workspaceIdentity,
            } as const;
            try {
              const services = windowRemoteConnectionRegistry.resolveScopedServices(nextScope);
              await windowHostControllerRuntime.replaceDisconnectedSource(previousScope, {
                scope: nextScope,
                taskService: services.get(IZCodeTaskService),
                sourceAvailability: "online",
              });
            } catch (error) {
              // When the source is connected but task-index is temporarily unreadable, do not roll back the transport or delete the previous generation's
              // offline trusted projection. The Controller keeps the pending replacement and atomically swaps it after a later query succeeds.
              logger.warn("failed to atomically replace disconnected Controller source", error);
            }
          }
          windowHostAttachmentRegistry.detachRemoteSessionAttachments(replaced.remoteSessionId);
          await windowRemoteConnectionRegistry.disposeSession(replaced.remoteSessionId);
          // After the reconnect replacement, the old remoteSessionId can no longer be attached; also clean up Main's port request association,
          // but do not falsely report a new transport failure to the Renderer.
          parentPort.postMessage({
            type: HostResponseTypes.RemoteWorkspaceClosed,
            remoteSessionId: replaced.remoteSessionId,
            reason: "disposed",
          });
        }
        parentPort.postMessage({
          type: HostResponseTypes.RemoteWorkspaceConnected,
          requestId: msg.requestId,
          descriptor,
        });
        logWindowHostTopology("remote-connected");
      })
      .catch((error) => {
        const failure = normalizeRemoteConnectionError(error);
        parentPort.postMessage({
          type: HostResponseTypes.RemoteWorkspaceConnectFailed,
          requestId: msg.requestId,
          error: sanitizeRemoteConnectionLog(failure.message) || "Remote connection failed",
          reasonCode: failure.code,
          ...(error instanceof SourceServerUpgradeRequiredError ||
          error instanceof SourceServerInstallRequiredError
            ? { profileId: error.profileId }
            : {}),
          // The host key trust step is keyed by the profile whose attempt observed the key.
          ...(failure.code === "remote-host-key-unknown" && readHostKeyProfileId(error)
            ? { profileId: readHostKeyProfileId(error) }
            : {}),
          // Installation and upgrade wait for the WSL identity fixed by Main's resolution and must not be rebuilt from the editable Profile.
          // The identity comes from the same request, independent of the attached install preview; only non-sensitive WSL connection parameters are returned.
          ...((error instanceof SourceServerInstallRequiredError ||
            error instanceof SourceServerUpgradeRequiredError) &&
          msg.target.kind === "wsl"
            ? { resolvedWslTarget: msg.target }
            : {}),
          ...(failure.retryable === undefined ? {} : { retryable: failure.retryable }),
        });
      });
    return;
  }

  if (msg.type === HostMessageTypes.CancelRemoteWorkspaceConnect) {
    projectNavigationAbortControllers.get(msg.requestId)?.abort();
    windowRemoteConnectionRegistry.cancelConnect(msg.requestId);
    return;
  }

  if (msg.type === HostMessageTypes.CancelRemoteWorkspaceBind) {
    cancelledWorkspaceBindRequestIds.add(msg.requestId);
    workspaceBindAbortControllers.get(msg.requestId)?.abort();
    // Bug cause: bind may join an existing Source logical session; cancelling a directory-selection request does not mean the session's other attachments/owners have released.
    // Only the request is cancelled here; it no longer disposes the session as collateral.
    if (!activeWorkspaceBindRequestIds.has(msg.requestId)) {
      parentPort.postMessage({
        type: HostResponseTypes.RemoteWorkspaceContextBindFailed,
        requestId: msg.requestId,
        error: "Remote workspace bind was canceled",
        reasonCode: REMOTE_BIND_CANCELED_ERROR_CODE,
        retryable: false,
      });
      cancelledWorkspaceBindRequestIds.delete(msg.requestId);
      workspaceBindAbortControllers.delete(msg.requestId);
    }
    return;
  }

  if (msg.type === HostMessageTypes.BindRemoteWorkspaceContext) {
    activeWorkspaceBindRequestIds.add(msg.requestId);
    const bindAbortController = new AbortController();
    workspaceBindAbortControllers.set(msg.requestId, bindAbortController);
    if (cancelledWorkspaceBindRequestIds.has(msg.requestId)) {
      bindAbortController.abort();
      parentPort.postMessage({
        type: HostResponseTypes.RemoteWorkspaceContextBindFailed,
        requestId: msg.requestId,
        error: "Remote workspace bind was canceled",
        reasonCode: REMOTE_BIND_CANCELED_ERROR_CODE,
        retryable: false,
      });
      activeWorkspaceBindRequestIds.delete(msg.requestId);
      cancelledWorkspaceBindRequestIds.delete(msg.requestId);
      workspaceBindAbortControllers.delete(msg.requestId);
      return;
    }
    const previous = windowRemoteConnectionRegistry.getSession(msg.remoteSessionId);
    let workspaceReady: Promise<void>;
    try {
      workspaceReady = windowRemoteConnectionRegistry.bindWorkspaceContext({
        remoteSessionId: msg.remoteSessionId,
        workspacePath: msg.workspacePath,
        workspaceIdentity: msg.workspaceIdentity,
        ...(msg.workspacePurpose ? { workspacePurpose: msg.workspacePurpose } : {}),
        ...(msg.legacyRouteHint ? { legacyWorkspaceIdentity: msg.legacyRouteHint } : {}),
        signal: bindAbortController.signal,
      });
    } catch (error) {
      logger.warn(
        `failed to bind remote workspace context, remoteSessionId=${msg.remoteSessionId}`,
        error,
      );
      parentPort.postMessage({
        type: HostResponseTypes.RemoteWorkspaceContextBindFailed,
        requestId: msg.requestId,
        error: error instanceof Error ? error.message : String(error),
        ...(error && typeof error === "object" && "code" in error && typeof error.code === "string"
          ? { reasonCode: error.code }
          : {}),
        ...(error &&
        typeof error === "object" &&
        "retryable" in error &&
        typeof error.retryable === "boolean"
          ? { retryable: error.retryable }
          : {}),
      });
      activeWorkspaceBindRequestIds.delete(msg.requestId);
      cancelledWorkspaceBindRequestIds.delete(msg.requestId);
      workspaceBindAbortControllers.delete(msg.requestId);
      return;
    }
    const current = windowRemoteConnectionRegistry.getSession(msg.remoteSessionId);
    if (current) {
      // After a scope generation change, the old Renderer/phone attachment must not keep holding the remote IO facade.
      windowHostAttachmentRegistry.detachStaleRemoteSessionAttachments(
        msg.remoteSessionId,
        current.generation,
      );
    }
    void workspaceReady
      .then(async () => {
        if (cancelledWorkspaceBindRequestIds.has(msg.requestId)) {
          throw Object.assign(new Error("Remote workspace bind was canceled"), {
            code: REMOTE_BIND_CANCELED_ERROR_CODE,
            retryable: false,
          });
        }
        const currentSession = windowRemoteConnectionRegistry.getSession(msg.remoteSessionId);
        if (!currentSession?.workspaceIdentity) {
          // Bug cause: the logical session may be released concurrently before bind completes; the old code returned directly, so Main
          // never received an ACK. Route it through the unified failure path to ensure each requestId settles exactly once.
          throw Object.assign(
            new Error(`远程 workspace bind 完成时 session 已失效: ${msg.remoteSessionId}`),
            {
              code: REMOTE_WORKSPACE_BIND_SESSION_MISSING_ERROR_CODE,
              retryable: true,
            },
          );
        }
        const scope = {
          kind: "remote" as const,
          ...(currentSession.sourceServerId
            ? { sourceServerId: currentSession.sourceServerId }
            : {}),
          remoteSessionId: msg.remoteSessionId,
          workspacePath: msg.workspacePath,
          workspaceIdentity: currentSession.workspaceIdentity,
        };
        await windowRemoteConnectionRegistry
          .resolveScopedCapabilities(scope)
          ?.recordWorkspaceOpen?.({
            workspacePath: msg.workspacePath,
            workspaceIdentity: currentSession.workspaceIdentity,
            ...(msg.workspacePurpose ? { workspacePurpose: msg.workspacePurpose } : {}),
            ...(msg.legacyRouteHint ? { legacyWorkspaceIdentity: msg.legacyRouteHint } : {}),
            signal: bindAbortController.signal,
          });
        if (cancelledWorkspaceBindRequestIds.has(msg.requestId)) {
          throw Object.assign(new Error("Remote workspace bind was canceled"), {
            code: REMOTE_BIND_CANCELED_ERROR_CODE,
            retryable: false,
          });
        }
        if (previous?.workspacePath && previous.workspaceIdentity) {
          windowHostControllerRuntime.removeSource({
            kind: "remote",
            ...(previous.sourceServerId ? { sourceServerId: previous.sourceServerId } : {}),
            remoteSessionId: msg.remoteSessionId,
            workspacePath: previous.workspacePath,
            workspaceIdentity: previous.workspaceIdentity,
          });
        }
        parentPort.postMessage({
          type: HostResponseTypes.RemoteWorkspaceContextBound,
          requestId: msg.requestId,
          // Bug cause: when a Source workspace is first opened from an old route tab, the Renderer got only the stable
          // identity and wrongly assumed there was no old tab, so addTab created a second workspace. Return the old route used by this bind
          // as a one-time tab-rekey hint; it is not the task routing identity, and the phone ignores it.
          ...(msg.legacyRouteHint && msg.legacyRouteHint !== currentSession.workspaceIdentity
            ? { previousWorkspaceIdentity: msg.legacyRouteHint }
            : {}),
        });
        logger.info(
          `bound remote workspace context, remoteSessionId=${msg.remoteSessionId}, workspacePath=${msg.workspacePath}`,
        );
        activeWorkspaceBindRequestIds.delete(msg.requestId);
        cancelledWorkspaceBindRequestIds.delete(msg.requestId);
        workspaceBindAbortControllers.delete(msg.requestId);
      })
      .catch((error) => {
        logger.warn(
          `failed to prepare bound remote workspace, remoteSessionId=${msg.remoteSessionId}`,
          error,
        );
        const normalizedError = cancelledWorkspaceBindRequestIds.has(msg.requestId)
          ? Object.assign(new Error("Remote workspace bind was canceled"), {
              code: REMOTE_BIND_CANCELED_ERROR_CODE,
              retryable: false,
            })
          : error;
        parentPort.postMessage({
          type: HostResponseTypes.RemoteWorkspaceContextBindFailed,
          requestId: msg.requestId,
          error:
            normalizedError instanceof Error ? normalizedError.message : String(normalizedError),
          ...(normalizedError &&
          typeof normalizedError === "object" &&
          "code" in normalizedError &&
          typeof normalizedError.code === "string"
            ? { reasonCode: normalizedError.code }
            : {}),
          ...(normalizedError &&
          typeof normalizedError === "object" &&
          "retryable" in normalizedError &&
          typeof normalizedError.retryable === "boolean"
            ? { retryable: normalizedError.retryable }
            : {}),
        });
        activeWorkspaceBindRequestIds.delete(msg.requestId);
        cancelledWorkspaceBindRequestIds.delete(msg.requestId);
        workspaceBindAbortControllers.delete(msg.requestId);
      });
    return;
  }

  if (msg.type === HostMessageTypes.DisposeRemoteWorkspaceSession) {
    const disposedSession = windowRemoteConnectionRegistry.getSession(msg.remoteSessionId);
    windowHostAttachmentRegistry.detachRemoteSessionAttachments(msg.remoteSessionId);
    void windowRemoteConnectionRegistry
      .disposeSession(msg.remoteSessionId)
      .then(() => {
        if (disposedSession?.workspacePath && disposedSession.workspaceIdentity) {
          windowHostControllerRuntime.removeSource({
            kind: "remote",
            ...(disposedSession.sourceServerId
              ? { sourceServerId: disposedSession.sourceServerId }
              : {}),
            remoteSessionId: msg.remoteSessionId,
            workspacePath: disposedSession.workspacePath,
            workspaceIdentity: disposedSession.workspaceIdentity,
          });
        }
        parentPort.postMessage({
          type: HostResponseTypes.RemoteWorkspaceClosed,
          remoteSessionId: msg.remoteSessionId,
          reason: "disposed",
        });
        logWindowHostTopology("remote-session-disposed");
      })
      .catch((error) => {
        logger.warn(
          `failed to dispose remote logical session, remoteSessionId=${msg.remoteSessionId}`,
          error,
        );
      });
    return;
  }

  if (msg.type === HostMessageTypes.SetTerminalOwner) {
    terminalOwners.setOwner(msg.ownerId);
    return;
  }

  if (msg.type === HostMessageTypes.AttachServicePort) {
    if (!port) {
      logger.error("attach-service-port message missing MessagePort");
      return;
    }
    if (msg.scope.kind === "local" && databaseStartup?.coordinator.snapshot.phase !== "ready") {
      // A refresh or phone attachment reuses the same Host and waits for the existing preparation instead of starting a second executor.
      pendingStartupAttachments.set(msg.attachmentId, () => {
        windowHostAttachmentRegistry.attach({ ...msg, port });
      });
      port.once("close", () => pendingStartupAttachments.delete(msg.attachmentId));
      return;
    }
    try {
      if (msg.clientMode === "web-remote-replayable" && msg.scope.kind === "source-settings") {
        throw new Error("Source settings attachments are Desktop-only");
      }
      if (msg.scope.kind === "remote") {
        // Bind and Attach share parentPort, but a previous-generation WSL workspace release may still be in flight.
        // Hold the transferred port and wait for the in-Host generation barrier, so a new attachment does not step over the old runtime cleanup.
        await windowRemoteConnectionRegistry.waitForScopedServices(msg.scope);
      }
      windowHostAttachmentRegistry.attach({
        requestId: msg.requestId,
        attachmentId: msg.attachmentId,
        clientMode: msg.clientMode,
        terminalOwnerId: msg.terminalOwnerId,
        scope: msg.scope,
        port,
      });
      logger.info(
        `attached scoped service port, attachmentId=${msg.attachmentId}, scope=${msg.scope.kind}, clientMode=${msg.clientMode}`,
      );
      logWindowHostTopology("attachment-added");
    } catch (error) {
      // A port from another logical session or an old identity must not stay exposed, or it would route remote requests to the wrong source.
      // A failed scope check must close the transferred port and log it explicitly; it must not fall back to the active local services.
      rejectUnavailableAttachedServicePort(port, false);
      logger.warn(`failed to attach scoped service port, attachmentId=${msg.attachmentId}`, error);
    }
    return;
  }

  if (msg.type === HostMessageTypes.DetachServicePort) {
    pendingStartupAttachments.delete(msg.attachmentId);
    windowHostAttachmentRegistry.detach(msg.attachmentId);
    logger.info(`detached service port, attachmentId=${msg.attachmentId}`);
    logWindowHostTopology("attachment-removed");
    return;
  }

  if (!port) {
    return;
  }

  if (msg.type === HostMessageTypes.InitLocal) {
    browserBackendIdentity = msg.browserBackendIdentity;
    if (!port) {
      logger.error("init-local message missing MessagePort");
      return;
    }
    if (databaseStartup) {
      port.close();
      databaseStartup.coordinator.publish();
      return;
    }
    let basePortClosed = false;
    port.once("close", () => {
      basePortClosed = true;
    });
    databaseStartup = createHostDatabaseStartup({
      startupId: msg.databaseStartupId,
      sweepAbandonedReservations: msg.sweepAbandonedReservations === true,
      cwd: msg.agentSpawnFallbackCwd ?? process.cwd(),
      workingDirectories:
        msg.agentWarmupTargets?.map((target) => target.workspacePath) ??
        (msg.workspacePath ? [msg.workspacePath] : []),
      env: msg.runtimeProcessEnvPatch,
      publish: (state) => {
        parentPort?.postMessage({ type: HostResponseTypes.DatabaseStartupState, state });
        if (state.phase === "ready") {
          for (const attach of pendingStartupAttachments.values()) {
            try {
              attach();
            } catch (error) {
              logger.warn("startup attachment failed", error);
            }
          }
          pendingStartupAttachments.clear();
        }
      },
      onFailure: (error) =>
        logger.error(
          `local database startup failed attempt=${databaseStartup?.coordinator.snapshot.attemptId}`,
          error,
        ),
      initializeServices: async () => {
        logger.info("initializing local services");
        activeSessionRealtimePort = createTaskRealtimeBridgeForHostInit(msg, parentPort);
        // Adding the organization for legacy Teams must share the same Setting instance and write queue as the network-proxy read.
        // Injecting only the service would skip the default assembly branch, so upgraded users missing the organization could never recover the connection.
        const {
          service: settingService,
          prepareLegacyAccountConnections,
          setWorkspaceProjection,
        } = createSettingServiceWithMigrations();
        const hostApiNetworkTransport = createHostApiNetworkTransport(async () => {
          const settings = await settingService.get();
          return {
            httpProxy: settings.httpProxy,
            noProxy: settings.httpProxyNoProxy,
            caCertPath: settings.httpProxyCaCertPath,
          };
        });
        const services = await initializeHostApiNetworkTransportOwner({
          transport: hostApiNetworkTransport,
          log: (message, details) => logger.warn(message, details),
          establishOwner: () => {
            const initializedServices = createLocalServices({
              reportPluginTelemetryEvent: (event) => {
                parentPort?.postMessage({
                  type: HostResponseTypes.PluginTelemetry,
                  event: {
                    ...event,
                    context: {
                      ...event.context,
                      screenResolution: event.context.screenResolution || "unknown",
                    },
                  },
                });
              },
              resolveBotProjectConnection,
              resolveBotRemoteWorkspace: (workspace) =>
                sourceServerDirectory
                  ? resolveBotRemoteWorkspace(workspace, "lookup", {
                      directory: sourceServerDirectory,
                      listSessions: () => windowRemoteConnectionRegistry.listSessions(),
                    })
                  : Promise.resolve(null),
              setWorkspaceProjection,
              remoteProjectConnection: {
                connectHost: async (host) => {
                  if (host.target?.kind === "server") {
                    const connected = await windowRemoteConnectionRegistry.connectSource({
                      target: host.target,
                      remoteAssets: msg.remoteAssets ?? {},
                      membershipIntent: "retain",
                    });
                    return remoteProjectHostIdForTarget(host.target, connected.sourceServerId);
                  }
                  if (!sourceServerManagementService)
                    throw new Error("remote-project.connector-unavailable");
                  const management = sourceServerManagementService;
                  const snapshot = await management.getSnapshot();
                  const profiles = snapshot.profiles.filter(
                    (profile) =>
                      profile.lifecycleState !== "retired" &&
                      remoteProjectHostIdForProfile(profile) === host.id,
                  );
                  const preferred = new Set(
                    snapshot.servers.map((server) => server.preferredProfileId),
                  );
                  const profile =
                    profiles.find((item) => preferred.has(item.profileId)) ?? profiles[0];
                  if (!profile) throw new Error("remote-project.profile-not-found");
                  const connected = await management.connectProfile(profile.profileId, {
                    retainedOnly: true,
                  });
                  const resolved = connected.profiles.find(
                    (item) => item.profileId === profile.profileId,
                  );
                  if (
                    !resolved ||
                    !connected.states.some(
                      (state) => state.profileId === resolved.profileId && state.state === "online",
                    )
                  )
                    throw new Error("project.host-offline");
                  return remoteProjectHostIdForProfile(resolved);
                },
                readConnectionStates: async () => {
                  const result = new Map<
                    string,
                    Pick<
                      RemoteProjectHost,
                      | "connectionStatus"
                      | "lastConnectionError"
                      | "lastConnectionStatus"
                      | "upgradeTarget"
                    >
                  >();
                  for (const state of windowRemoteConnectionRegistry.listConnections()) {
                    if (state.target.kind !== "server") continue;
                    result.set(remoteProjectHostIdForTarget(state.target, state.sourceServerId), {
                      connectionStatus:
                        state.state === "online"
                          ? "online"
                          : state.state === "connecting"
                            ? "connecting"
                            : "offline",
                    });
                  }
                  if (!sourceServerDirectory || !sourceServerConnectionManager) return result;
                  const snapshot = await sourceServerDirectory.snapshot();
                  for (const state of sourceServerConnectionManager.listStates()) {
                    const profile = snapshot.profiles.find(
                      (item) => item.profileId === state.profileId,
                    );
                    if (!profile) continue;
                    const id = remoteProjectHostIdForProfile(profile);
                    const value =
                      state.state === "online"
                        ? "online"
                        : ["bootstrapping", "retrying", "updating"].includes(state.state)
                          ? "connecting"
                          : "offline";
                    if (
                      result.get(id)?.connectionStatus !== "online" &&
                      (result.get(id)?.connectionStatus !== "connecting" || value === "online")
                    )
                      result.set(id, {
                        connectionStatus: value,
                        lastConnectionError: state.error,
                        lastConnectionStatus: state.state,
                        // Fix cause: the projection once dropped upgradeTarget, so on an outdated desktop the detail entry wrongly showed "Update remote".
                        upgradeTarget: state.upgradeTarget,
                      });
                  }
                  return result;
                },
              },
              resolveProjectHostService: async (hostId) => {
                const serverId = parseRemoteWorkspaceIdentity(
                  buildRemoteHostWorkspaceIdentity(hostId, "/"),
                )?.sourceServerId;
                const registered = serverId
                  ? windowRemoteConnectionRegistry.getOnlineSource(serverId)
                  : undefined;
                if (registered && serverId) {
                  // A Registry handle does not change generation across Source reconnects; deduplicate by physical connection so it re-registers after a Core restart.
                  const physicalConnection =
                    registered.capabilities?.physicalOwner?.() ?? registered.services;
                  return bindRemoteProjectIdentities(
                    registered.services.get(IProjectService),
                    (workspacePath) =>
                      registryProjectIdentityRegistrations(
                        physicalConnection,
                        workspacePath,
                        async () => {
                          const workspaceIdentity = buildServerRemoteWorkspaceIdentity({
                            serverId,
                            workspacePath,
                          });
                          await registered.capabilities?.bindWorkspaceIdentity?.({
                            workspacePath,
                            stableWorkspaceIdentity: workspaceIdentity,
                          });
                          return workspaceIdentity;
                        },
                      ),
                  );
                }
                const source = sourceServerConnectionManager?.listStates().find(
                  (state) =>
                    state.sourceServerId &&
                    remoteHostIdFromWorkspaceIdentity(
                      buildServerRemoteWorkspaceIdentity({
                        serverId: state.sourceServerId,
                        workspacePath: "/",
                      }),
                    ) === hostId,
                );
                const connection = source?.sourceServerId
                  ? sourceServerConnectionManager?.getOnlineConnection(source.sourceServerId)
                  : undefined;
                if (!connection || !source?.sourceServerId) throw new Error("project.host-offline");
                const sourceServerId = source.sourceServerId;
                return bindRemoteProjectIdentities(
                  resolveServerProjectService({
                    connectionServices: connection.services,
                    serverId: sourceServerId,
                    virtualProjects: connection.serverInfo.capabilities.virtualProjects,
                    sourceServices: activeServices ?? undefined,
                  }),
                  (workspacePath) =>
                    managerProjectIdentityRegistrations(
                      connection.services,
                      workspacePath,
                      async () => {
                        const workspaceService = requireSourceServerWorkspaceService(
                          connection.services,
                        );
                        await workspaceService.resolveWorkspace({
                          workspacePath,
                        });
                        return buildServerRemoteWorkspaceIdentity({
                          serverId: sourceServerId,
                          workspacePath,
                        });
                      },
                    ),
                );
              },
              parentPort,
              settingService,
              prepareLegacyAccountConnections,
              hostApiNetworkTransport,
              resolveClientLanguage: () => applicationLocale,
              authorizeLocalMediaPreviewPath,
              // launch.md "The user's choice": when the local user's choice changes, push it to all online remote Hosts of this window.
              forwardDynamicWorkflowUserMode: (mode) => {
                void pushDynamicWorkflowUserModeToRemoteHosts(
                  windowRemoteConnectionRegistry
                    .listReadyConnections()
                    .map(({ target, services: remoteServices }) => ({
                      target,
                      zcodeAgentService: remoteServices.get(IZCodeAgentService),
                    })),
                  mode,
                  (error) => logger.warn("remote dynamic workflow user mode forward failed", error),
                );
              },
              registerPluginSandbox: pluginSandboxRegistrationBridge.register,
              runtimeProcessEnvPatch: msg.runtimeProcessEnvPatch,
              agentTelemetry: {
                getDeviceMid: () => msg.deviceMid,
                runtimeSurface: "desktop_local_host",
              },
              serviceAuthorityMode: "desktop-local",
              zcodeAgentSpawnFallbackCwd: msg.agentSpawnFallbackCwd,
              zcodeBuiltinProviderConfigFilePath: msg.zcodeBuiltinProviderConfigFilePath,
              processLifecycleReporter: runtimeProcessLifecycleReporter,
              taskRuntimeReporter: runtimeTaskReporter,
              getOpenWorkspacePaths: async () => {
                const inventory = await requestOpenWorkspaceInventory();
                if (!inventory.available)
                  throw new Error("Open workspace inventory is incomplete.");
                return inventory.paths;
              },
              feedback: {
                getDeviceMid: () => msg.deviceMid,
                apiBaseUrl: msg.feedbackApiBase,
                createFullLogArchive: createFullFeedbackLogArchiveViaMain,
              },
              forwardSessionMessageSendRequested: (request) => {
                parentPort?.postMessage({
                  type: HostResponseTypes.SessionMessageSendRequested,
                  request,
                });
              },
              onAutomationManualRunRequested: dispatchManualAutomationRun,
              onOffPeakSchedulerWakeRequested: () => {
                parentPort?.postMessage({ type: HostResponseTypes.OffPeakSchedulerWakeRequest });
              },
              onProviderProvisioningSourceChanged: (trigger) => {
                parentPort?.postMessage({
                  type: HostResponseTypes.ProviderProvisioningSourceChanged,
                  trigger,
                });
              },
              // browser-use: the agent's interaction/browserExecute goes through zcodeAgentService to this executor,
              // then reaches main's WebContentsView+CDP via parentPort.
              browserControlExecutor: browserControlMainBridge,
              // The CUA top hint belongs to the physical Windows desktop projection; non-Windows and remote authorities must never report it.
              cuaOperationStateReporter:
                process.platform === "win32" ? cuaOperationStateReporter : undefined,
            });
            activeServices = initializedServices;
            activeHostApiNetworkTransport = hostApiNetworkTransport;
            return initializedServices;
          },
        });
        const zcodeTaskService = services.getOptional(IZCodeTaskService);
        if (zcodeTaskService) {
          const reportingZCodeTaskService = createReportingRemoteZCodeTaskService(
            zcodeTaskService,
            {
              reportRunningPromptCount: false,
            },
          );
          services.register(IZCodeTaskService, reportingZCodeTaskService);
        }
        sourceServerDirectory = new SourceServerDirectory({
          settingService: services.get(ISettingService),
          credentialService: services.get(ICredentialService),
          // The host domain has no debug log channel; with debug semantics it only outputs in non-production builds, and production is a no-op to prevent disk writes.
          logDebug: (message) => {
            if (process.env.NODE_ENV !== "production") logger.info(message);
          },
          logWarn: (message) => logger.warn(message),
        });
        sourceServerArtifactPolicy =
          msg.remoteAssets?.sourceServerArtifactPolicy ?? "release-versioned";
        // Bug cause: the release resolver used to be passed only to updateSource; startup recovery and connectProfile called the Manager directly,
        // and at the development-content-addressed same-version check it could not get the local archive, so it always reported unavailable.
        const resolveSourceServerRelease = async (
          probe: Parameters<typeof resolveSourceServerReleaseAsset>[0],
          target: Parameters<typeof resolveSourceServerReleaseAsset>[2],
          options?: { metadataOnly?: boolean },
        ) =>
          await resolveSourceServerReleaseAsset(
            probe,
            msg.remoteAssets ?? {},
            target,
            {
              fetch: hostApiNetworkTransport.fetch,
            },
            options,
          );
        sourceServerConnectionManager = new SourceServerConnectionManager({
          directory: sourceServerDirectory,
          admitConnection: createRemoteProjectConnectionAdmission(
            services.get(IRemoteProjectService),
          ),
          onProjectChange: notifyProjectChange,
          logWarn: (message, error) => logger.warn(message, error),
          sourceServerArtifactPolicy,
          resolveRelease: resolveSourceServerRelease,
        });
        sourceServerManagementService = createSourceServerManagementService({
          directory: sourceServerDirectory,
          manager: sourceServerConnectionManager,
          resolveRelease: resolveSourceServerRelease,
          onDirectorySnapshot: (snapshot) => {
            sourceServerDisplayNameById.clear();
            for (const server of snapshot.servers) {
              sourceServerDisplayNameById.set(server.sourceServerId, server.displayName);
            }
          },
          onBeforeSourceServerRemoved: async (sourceServerId) => {
            const hostId = remoteHostIdFromWorkspaceIdentity(
              buildServerRemoteWorkspaceIdentity({ serverId: sourceServerId, workspacePath: "/" }),
            );
            if (!hostId) throw new Error("remote-project.invalid-host-identity");
            await services.get(IRemoteProjectService).removeHost(hostId);
            windowHostAttachmentRegistry.detachSourceSettingsAttachments(sourceServerId);
            sourceServerDisplayNameById.delete(sourceServerId);
          },
        });
        sourceSettingsStateSubscription = sourceServerConnectionManager.onDidChangeState(
          (state) => {
            notifyProjectChange();
            if (state.sourceServerId && shouldDetachSourceSettingsAttachment(state.state)) {
              windowHostAttachmentRegistry.detachSourceSettingsAttachments(state.sourceServerId);
            }
          },
        );
        services.register(ISourceServerManagementService, sourceServerManagementService);
        // The Data Sync page's device sync state belongs only to the local Host: it does not enter the remote workspace RPC contract,
        // the source-settings service set, or the phone attachment allowlist.
        services.register(
          IDeviceSyncStateService,
          createDeviceSyncStateService({
            filePath: join(getAppConfigDir(), "data-sync-state.json"),
          }),
        );
        services.register(
          IProviderProvisioningStatusService,
          hostProviderProvisioningStatus.service,
        );
        wireLocalResourceTelemetry(services);
        hasDisposedHostResources = false;
        disposeHostResourcesInFlight = null;
        const agentWarmupTargets =
          msg.agentWarmupTargets && msg.agentWarmupTargets.length > 0
            ? msg.agentWarmupTargets
            : msg.workspacePath
              ? [
                  {
                    workspacePath: msg.workspacePath,
                    ...(msg.workspaceIdentity ? { workspaceIdentity: msg.workspaceIdentity } : {}),
                  },
                ]
              : [];
        // Main limits startup warmup to 1 active workspace; the Host must explicitly consume this fixed list,
        // must not let the later task-list observer expand it implicitly, and must not backfill on failed scans.
        agentWarmupTargets.forEach((target, index) => {
          warmUpZCodeAgent(
            services,
            target,
            `local host init (${index + 1}/${agentWarmupTargets.length})`,
          );
        });
        logger.info("exposing services on ChannelServer...");
        if (!basePortClosed)
          windowHostAttachmentRegistry.attach({
            requestId: `init-local-${randomUUID()}`,
            attachmentId: `base-${randomUUID()}`,
            clientMode: "desktop-continuous",
            scope: { kind: "local" },
            port,
          });
        logWindowHostTopology("base-attachment-ready");
        logger.info("local services ready, all channels registered");
        // The URL Host reuses the same startup switch and Registry; project discovery creates no logical workspace/Agent.
        void runStartupReconnectBatch({
          getSettings: () => services.get(ISettingService).get(),
          listCandidates: async () =>
            (await services.get(IRemoteProjectService).readDirectory()).hosts.filter(
              (host) => host.kind === "server",
            ),
          reconnect: (hosts) =>
            Promise.all(
              hosts.map(async (host) => {
                try {
                  await services.get(IRemoteProjectService).connectHost(host.id);
                } catch (error) {
                  logger.warn("URL Server startup reconnect failed", { hostId: host.id, error });
                }
              }),
            ),
        }).catch((error) => logger.warn("URL Server startup directory unavailable", error));

        // Bug cause: Directory migration is a remote attachment capability; waiting for it to finish would drag down the local base attachment's
        // first frame. Initialize in the background after base is ready; the failed flight is cleared and an explicit user connection can still retry.
        void sourceServerDirectory
          .initialize()
          .then(async () =>
            runStartupReconnectBatch({
              getSettings: () => services.get(ISettingService).get(),
              listCandidates: async () => {
                const retained = new Set(
                  (await services.get(IRemoteProjectService).readDirectory()).hosts.map(
                    (host) => host.id,
                  ),
                );
                return (await sourceServerDirectory!.listStartupReconnectCandidates()).filter(
                  (candidate) => retained.has(remoteProjectHostIdForProfile(candidate.profile)),
                );
              },
              reconnect: (candidates) =>
                sourceServerConnectionManager!.reconnectOnStartup(candidates),
            }),
          )
          .then((results) => {
            const online = results.filter((result) => result.status === "online").length;
            // Bug cause: previously only the failure count was recorded and the real Profile/reason was swallowed, so a cold-start failure could only be re-triggered by
            // a manual reconnect. The startup batch is at most 3 entries, and per-item warns do not create high-frequency logs.
            for (const result of results) {
              if (result.status === "failed") {
                logger.warn("Source Server startup reconnect failed", {
                  profileId: result.profileId,
                  error: result.error,
                });
              }
            }
            logger.info(
              `Source Server startup reconnect finished, online=${online}, failed=${results.length - online}`,
            );
          })
          .catch((error) =>
            logger.warn(
              "Source Server directory initialization failed; local services remain available",
              error,
            ),
          );
      },
    });
    await databaseStartup.coordinator.start();
  }
});

import type { RendererTelemetryEventPayload } from "@zcode/shared";
/* eslint-disable max-lines -- The Web remote control manager routes external relay app payloads and orchestrates workspace bridges. */
import type { MessagePortMain, UtilityProcess as ElectronUtilityProcess } from "electron";
import { randomUUID } from "node:crypto";
import { MessagePortProtocol, type MessagePortLike, type MessagePortPayload } from "@zcode/rpc";
import {
  createAcknowledgedWebRemoteControlRelayProtocol,
  type AcknowledgedWebRemoteControlRelayProtocolAdapter,
  type WebRemoteControlPayloadSendResult,
} from "@zcode/client";
import {
  buildWebRemoteControlExternalQrUrl,
  buildWebRemoteControlBridgeResultTelemetry,
  buildWebRemoteControlPairResultTelemetry,
  classifyRemoteUsageError,
  parseRemoteWorkspaceIdentity,
  WEB_REMOTE_CONTROL_OUTBOUND_PAYLOAD_BUFFER_TIMEOUT_MS,
  type ZCodeEndpointUrls,
  type HostPreparedProjectWorkspace,
  type HostProjectWorkspaceNavigationInput,
  resolveWebRemoteControlWorkspaceKey,
  type WebRemoteControlAppPayload,
  type WebRemoteControlAuthStateChange,
  type WebRemoteControlContext,
  type WebRemoteControlExternalWorkspaceBridge,
  type WebRemoteControlFailure,
  type WebRemoteControlFailureReason,
  type WebRemoteControlMobileDeviceInfo,
  type WebRemoteControlMobileViewState,
  type WebRemoteControlMobileTaskViewUpdatePayload,
  type WebRemoteControlPlatformMethod,
  type WebRemoteControlPlatformMethodArgsMap,
  type WebRemoteControlPlatformMethodResultMap,
  type WebRemoteControlPlatformRequestPayload,
  type WebRemoteControlPlatformResponsePayload,
  type WebRemoteControlRpcTransportPayload,
  type WebRemoteControlStartResult,
  type WebRemoteControlStatus,
  type WebRemoteControlWindowBootstrapResult,
  type WebRemoteControlWorkspaceBridgeOpenPayload,
  type WebRemoteControlWorkspaceListResult,
  type WebRemoteControlWorkspaceOpenRequestPayload,
  type WebRemoteControlWorkspaceOpenResponsePayload,
  type WebRemoteControlWorkspaceTarget,
  type RemoteUsageRemoteKind,
  type TelemetryEventPayload,
  measureWebRemoteControlRpcRelayEnvelopeBytes,
} from "@zcode/shared";
import { WebRemoteControlV2ConnectionError } from "@zcode/shared/web-remote-relay";
import {
  WebRemoteControlDeviceTransport,
  type WebRemoteControlDeviceTransportOptions,
  type WebRemoteControlDeviceTransportState,
  createWebRemoteControlV2Http,
  type WebRemoteControlLogin,
} from "#src/main/web-remote-relay/index.js";
import type {
  WebRemoteControlDeviceStorage,
  WebRemoteControlRelayBearer,
} from "#src/main/web-remote-relay/index.js";

import type { WebRemoteControlFeatureGate } from "./webRemoteControlFeatureGate.js";

interface WebRemoteControlHostAttachmentHandle {
  entryId: string;
  attachmentId: string;
  process: ElectronUtilityProcess;
  port: MessagePortMain;
  remoteKind?: RemoteUsageRemoteKind;
}

interface WorkspaceBridgeRuntime {
  bridgeSessionId: string;
  bridgeGeneration?: number;
  recoveryId?: string;
  hostEntryId: string;
  attachmentId: string;
  kind: "local" | "remote";
  workspaceKey: string;
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  initialTaskId?: string;
  hostProtocol?: MessagePortProtocol;
  relayProtocol?: AcknowledgedWebRemoteControlRelayProtocolAdapter;
  disposeBridge?: () => void;
  readyAnnounced: boolean;
  degraded: boolean;
}

interface WebRemoteControlDeviceTransportLike {
  start(): void;
  sendPayload(payload: WebRemoteControlAppPayload): boolean;
  sendPayloadResult?(payload: WebRemoteControlAppPayload): WebRemoteControlPayloadSendResult;
  measurePayloadBytes?(payload: WebRemoteControlAppPayload): number;
  dispose(): void;
}

interface WebRemoteControlStartupRestoreContext {
  workspacePath: string;
  workspaceIdentity?: string;
  initialTaskId?: string;
}

export interface WebRemoteControlStartAuthorization {
  token: string;
  expiresAt: number;
  windowId: number;
  workspaceKey: string;
  remoteSessionId?: string;
}

const WEB_REMOTE_CONTROL_START_AUTHORIZATION_TTL_MS = 30_000;

interface WindowControlLifecycle {
  controller: AbortController;
  identity?: { userId: string; endpointOrigin: string };
}

interface WindowControlRuntime {
  windowId: number;
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  initialTaskId?: string;
  theme?: WebRemoteControlContext["theme"];
  status: WebRemoteControlStatus["status"];
  error?: string;
  failure?: WebRemoteControlFailure;
  repairRequired?: boolean;
  deviceSid: string;
  deviceMid: string;
  connectUrl: string;
  qrUrl: string;
  transport: WebRemoteControlDeviceTransportLike;
  mobileConnected: boolean;
  hasEverPaired: boolean;
  hasObservedSendReadyForPairing: boolean;
  transportState?: WebRemoteControlDeviceTransportState;
  mobileViewState?: WebRemoteControlMobileViewState;
  mobileTaskView?: NonNullable<WebRemoteControlStatus["mobileTaskView"]>;
  mobileTaskViewEpoch?: string;
  mobileTaskViewSeq?: number;
  mobileDeviceInfo?: WebRemoteControlMobileDeviceInfo;
  currentBridge?: WorkspaceBridgeRuntime;
  bridgeOpen?: {
    bridgeSessionId: string;
    bridgeGeneration?: number;
    intentKey: string;
    hostRequestId: string;
    preparingProject: boolean;
    promise: Promise<WebRemoteControlExternalWorkspaceBridge>;
  };
  pendingBridgeInvalidation?: Extract<
    WebRemoteControlAppPayload,
    { zcode_type: "bridge-degraded" }
  >;
  pendingOutboundPayloads: WebRemoteControlAppPayload[];
  pendingOutboundPayloadTimer?: ReturnType<typeof setTimeout>;
  mobileDisconnectGraceTimer?: ReturnType<typeof setTimeout>;
}

interface WebRemoteControlManagerDependencies {
  getEndpointUrls?: () => Promise<ZCodeEndpointUrls> | ZCodeEndpointUrls;
  relayWsUrl: string;
  mobileRemoteControlUrl: string;
  deviceMid: string;
  deviceName: string;
  appVersion: string;
  getLogin(): Promise<WebRemoteControlLogin | undefined>;
  // Exchanges the account identity for the relay-signed JWT that every relay HTTP and WS call uses.
  // When omitted, the identity JWT is used directly (upstream behavior).
  relayBearer?: WebRemoteControlRelayBearer;
  deviceStorage: WebRemoteControlDeviceStorage;
  startupRestoreStorageProvider: {
    load(): Promise<WebRemoteControlStartupRestoreContext | undefined>;
    save(context: WebRemoteControlStartupRestoreContext): Promise<void>;
    clear(): Promise<void>;
  };
  featureGate: WebRemoteControlFeatureGate;
  logger: {
    info: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
  };
  relayMessageLogger?: {
    info: (...args: unknown[]) => void;
  };
  platformHandlers: {
    [K in WebRemoteControlPlatformMethod]: (
      args: WebRemoteControlPlatformMethodArgsMap[K],
    ) => Promise<WebRemoteControlPlatformMethodResultMap[K]>;
  };
  reconnectWorkspace: (windowId: number, workspaceKey: string) => Promise<void>;
  /**
   * Open (or reuse) a local workspace in the desktop window renderer. Reuses the deep-link
   * workspace-open routing; resolves once Main dispatched the open, rejects when the path is
   * invalid or the window is gone. The renderer keeps ownership of tab/dedup semantics.
   */
  openWorkspace: (
    windowId: number,
    target: { workspacePath: string; workspaceIdentity?: string },
  ) => Promise<void>;
  prepareProjectWorkspace?: (
    windowId: number,
    project: HostProjectWorkspaceNavigationInput,
    requestId: string,
  ) => Promise<HostPreparedProjectWorkspace>;
  cancelProjectPreparation?: (windowId: number, requestId: string) => void;
  reportRemoteUsageEvent?: (windowId: number, event: TelemetryEventPayload) => void;
  reportRendererTelemetryEvent?: (event: RendererTelemetryEventPayload) => void;
  onStatusChanged?: (windowId: number, status: WebRemoteControlStatus) => void;
  attachWorkspaceHost: (
    windowId: number,
    context: WebRemoteControlContext & { kind: "local" | "remote" },
  ) => Promise<WebRemoteControlHostAttachmentHandle>;
  releaseWorkspaceHostAttachment: (attachmentId: string) => void;
  disposeWorkspaceHostAttachmentsForWindow: (windowId: number, reason: string) => void;
  disposeWorkspaceHostAttachmentsForRemoteSession: (
    remoteSessionId: string,
    reason: string,
  ) => void;
  createDeviceTransport?: (
    options: WebRemoteControlDeviceTransportOptions,
  ) => WebRemoteControlDeviceTransportLike;
}

// Bugfix: first-time external relay authentication is affected by edge cold starts and network jitter; in practice it can slightly exceed 15s.
// Wait up to 30s here so a usable connection is not destroyed too early while the device is about to enter waiting_terminal.
const EXTERNAL_RELAY_QR_READY_TIMEOUT_MS = 30_000;
const MOBILE_DISCONNECT_STATUS_GRACE_MS = 3_000;

function createFailure(
  reason: WebRemoteControlFailureReason,
  message?: string,
): WebRemoteControlFailure {
  return { reason, message };
}

function getErrorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

function mapWorkspaceBridgeFailureReason(error: unknown): WebRemoteControlFailureReason {
  switch (getErrorCode(error)) {
    case "DESKTOP_HOST_MISSING":
      return "desktop-disconnected";
    case "REMOTE_SESSION_MISSING":
    case "REMOTE_SESSION_WINDOW_MISMATCH":
      return "workspace-closed";
    case "REMOTE_WORKSPACE_IDENTITY_MISSING":
    case "REMOTE_WORKSPACE_IDENTITY_MISMATCH":
      return "unsupported-action";
    default:
      return "unexpected-error";
  }
}

function wrapElectronPort(port: MessagePortMain): MessagePortLike {
  return {
    addEventListener(_type: "message", listener: (e: { data: MessagePortPayload }) => void) {
      port.on("message", listener);
    },
    removeEventListener(_type: "message", listener: (e: { data: MessagePortPayload }) => void) {
      port.off("message", listener);
    },
    postMessage(data: MessagePortPayload) {
      port.postMessage(data);
    },
    start() {
      port.start();
    },
    close() {
      port.close();
    },
  };
}

function getPathLabel(workspacePath: string): string {
  const normalized = workspacePath.replace(/\\/g, "/");
  const segments = normalized.split("/").filter(Boolean);
  return segments[segments.length - 1] ?? workspacePath;
}

/** Relay HTTP origin for a relay WS URL: wss to https, ws to http; the path is always the relay API root. */
function relayHttpOriginFromWsUrl(relayWsUrl: string): string {
  const url = new URL(relayWsUrl);
  url.protocol = url.protocol === "wss:" ? "https:" : "http:";
  return url.origin;
}

function isBridgeableRemoteTarget(target: WebRemoteControlWorkspaceTarget): boolean {
  return target.kind !== "remote" || Boolean(target.workspaceIdentity && target.remoteSessionId);
}

function toExternalBridge(
  runtime: WorkspaceBridgeRuntime,
): WebRemoteControlExternalWorkspaceBridge {
  const base = {
    bridgeSessionId: runtime.bridgeSessionId,
    ...(runtime.bridgeGeneration !== undefined
      ? { bridgeGeneration: runtime.bridgeGeneration }
      : {}),
    ...(runtime.recoveryId ? { recoveryId: runtime.recoveryId } : {}),
    workspaceKey: runtime.workspaceKey,
    workspacePath: runtime.workspacePath,
    initialTaskId: runtime.initialTaskId,
  };

  if (runtime.kind === "remote") {
    if (!runtime.workspaceIdentity || !runtime.remoteSessionId) {
      throw new Error(
        "The remote workspace bridge is missing workspaceIdentity or remoteSessionId.",
      );
    }
    return {
      ...base,
      kind: "remote",
      workspaceIdentity: runtime.workspaceIdentity,
      remoteSessionId: runtime.remoteSessionId,
      capabilities: { windowProjectDirectory: true },
    };
  }

  return {
    ...base,
    kind: "local",
  };
}

export function createWebRemoteControlManager(dependencies: WebRemoteControlManagerDependencies) {
  const runtimes = new Map<number, WindowControlRuntime>();
  // Identity binding and the cancellation token cover the whole lifecycle from first start to connection release; the JWT is not cached.
  const windowLifecycles = new Map<number, WindowControlLifecycle>();
  const authRequiredWindows = new Set<number>();
  let registrationQueue: Promise<unknown> = Promise.resolve();
  const startAuthorizations = new Map<string, WebRemoteControlStartAuthorization>();
  const availableWorkspacesByWindowId = new Map<number, WebRemoteControlWorkspaceTarget[]>();

  function reportRemoteUsageEvent(windowId: number, event: TelemetryEventPayload): void {
    try {
      dependencies.reportRemoteUsageEvent?.(windowId, event);
    } catch (error) {
      // Telemetry is a side channel; no exception may change the business outcome of remote-control pairing or the bridge.
      dependencies.logger.warn("[web-remote-control] remote usage telemetry failed", {
        elementName: event.elementName,
        error,
      });
    }
  }

  function resolveRemoteKind(
    target: WebRemoteControlWorkspaceTarget,
    acquired?: WebRemoteControlHostAttachmentHandle,
  ): RemoteUsageRemoteKind | undefined {
    if (target.kind !== "remote") {
      return undefined;
    }
    return (
      acquired?.remoteKind ??
      (target.workspaceIdentity
        ? parseRemoteWorkspaceIdentity(target.workspaceIdentity)?.kind
        : undefined)
    );
  }

  function resolveRuntimeWorkspaceDimensions(runtime: WindowControlRuntime): {
    workspaceKind: "local" | "remote";
    remoteKind?: RemoteUsageRemoteKind;
  } {
    const remoteKind = runtime.workspaceIdentity
      ? parseRemoteWorkspaceIdentity(runtime.workspaceIdentity)?.kind
      : undefined;
    return {
      workspaceKind:
        runtime.workspaceIdentity?.trim() || runtime.remoteSessionId ? "remote" : "local",
      remoteKind,
    };
  }
  const pushedWorkspaceListSignaturesByWindowId = new Map<number, string>();
  let startupRestoreClaimed = false;
  let lifecycleRevision = 0;
  let authNotificationRevision = 0;

  function createTransport(options: WebRemoteControlDeviceTransportOptions) {
    return dependencies.createDeviceTransport
      ? dependencies.createDeviceTransport(options)
      : new WebRemoteControlDeviceTransport(options);
  }

  function clearStartAuthorizationsForWindow(windowId: number): void {
    for (const [token, authorization] of startAuthorizations) {
      if (authorization.windowId === windowId) {
        startAuthorizations.delete(token);
      }
    }
  }

  function authorizeStart(
    windowId: number,
    context: WebRemoteControlContext,
  ): WebRemoteControlStartAuthorization {
    const now = Date.now();
    // Only the internal ticket from the most recent IPC dispatch is kept per window, so stale requests cannot coexist with a new workspace context.
    clearStartAuthorizationsForWindow(windowId);
    for (const [token, authorization] of startAuthorizations) {
      if (authorization.expiresAt <= now) {
        startAuthorizations.delete(token);
      }
    }

    const authorization: WebRemoteControlStartAuthorization = {
      token: randomUUID(),
      expiresAt: now + WEB_REMOTE_CONTROL_START_AUTHORIZATION_TTL_MS,
      windowId,
      workspaceKey: resolveWebRemoteControlWorkspaceKey(context),
      ...(context.remoteSessionId ? { remoteSessionId: context.remoteSessionId } : {}),
    };
    startAuthorizations.set(authorization.token, authorization);
    return authorization;
  }

  function consumeStartAuthorization(
    windowId: number,
    context: WebRemoteControlContext,
    authorization: WebRemoteControlStartAuthorization,
  ): void {
    const stored = startAuthorizations.get(authorization.token);
    startAuthorizations.delete(authorization.token);
    if (!stored || stored !== authorization) {
      throw new Error("Web remote control authorization is invalid or already used");
    }
    if (stored.expiresAt <= Date.now()) {
      throw new Error("Web remote control authorization expired");
    }
    if (
      stored.windowId !== windowId ||
      stored.workspaceKey !== resolveWebRemoteControlWorkspaceKey(context) ||
      stored.remoteSessionId !== context.remoteSessionId
    ) {
      throw new Error("Web remote control authorization target mismatch");
    }
  }

  function disposeRuntimeBridgeResources(runtime: WindowControlRuntime): void {
    clearMobileTaskView(runtime);
    const bridge = runtime.currentBridge;
    if (!bridge) {
      return;
    }

    bridge.disposeBridge?.();
    bridge.disposeBridge = undefined;
    bridge.relayProtocol?.dispose();
    bridge.relayProtocol = undefined;
    try {
      bridge.hostProtocol?.disconnect();
    } catch {
      // A dispose failure when MessagePortProtocol is already closed does not affect the main flow.
    }
    if (bridge.attachmentId) {
      dependencies.releaseWorkspaceHostAttachment(bridge.attachmentId);
    }

    runtime.currentBridge = undefined;
  }

  function isCurrentBridgeRuntime(
    runtime: WindowControlRuntime,
    bridge: WorkspaceBridgeRuntime,
  ): boolean {
    return runtimes.get(runtime.windowId) === runtime && runtime.currentBridge === bridge;
  }

  function degradeBridgeAfterRawFault(
    runtime: WindowControlRuntime,
    bridge: WorkspaceBridgeRuntime,
    reasonCode: string,
  ): void {
    if (!isCurrentBridgeRuntime(runtime, bridge) || bridge.degraded) return;
    bridge.degraded = true;
    dependencies.logger.warn("[web-remote-control] raw relay bridge degraded", {
      windowId: runtime.windowId,
      session: runtime.deviceSid,
      bridgeSessionId: bridge.bridgeSessionId,
      bridgeGeneration: bridge.bridgeGeneration,
      recoveryId: bridge.recoveryId,
      reasonCode,
    });
    runtime.pendingBridgeInvalidation = {
      zcode_type: "bridge-degraded",
      bridgeSessionId: bridge.bridgeSessionId,
      ...(bridge.bridgeGeneration === undefined
        ? {}
        : { bridgeGeneration: bridge.bridgeGeneration }),
      ...(bridge.recoveryId ? { recoveryId: bridge.recoveryId } : {}),
      // Bugfix: faults such as checksum, oversize, or future ACK must not masquerade as a frame gap;
      // app control only carries a generic recovery reason; the typed reasonCode stays in the safe log above.
      reason: "rpc-transport-fault",
    };
    // Bug cause: after degradation both raw ends are forbidden to keep forwarding; keeping the old attachment only leaks
    // the scoped subscription. The physical Host/Agent is unaffected; only the phone's short-lived attachment is released.
    disposeRuntimeBridgeResources(runtime);
    sendPendingBridgeInvalidation(runtime);
  }

  function clearPendingOutboundPayloadTimer(runtime: WindowControlRuntime): void {
    if (!runtime.pendingOutboundPayloadTimer) {
      return;
    }
    clearTimeout(runtime.pendingOutboundPayloadTimer);
    runtime.pendingOutboundPayloadTimer = undefined;
  }

  function clearMobileDisconnectGraceTimer(runtime: WindowControlRuntime): void {
    if (!runtime.mobileDisconnectGraceTimer) {
      return;
    }
    clearTimeout(runtime.mobileDisconnectGraceTimer);
    runtime.mobileDisconnectGraceTimer = undefined;
  }

  function buildRuntimeStatus(runtime: WindowControlRuntime): WebRemoteControlStatus {
    const target = getRuntimeStatusTarget(runtime);
    return {
      status: runtime.status,
      sessionId: runtime.deviceSid,
      windowControlSessionId: runtime.deviceSid,
      mobileConnected: runtime.mobileConnected,
      mobileViewState: runtime.mobileViewState,
      mobileTaskView: runtime.mobileTaskView ?? null,
      mobileDeviceInfo: runtime.mobileDeviceInfo,
      qrUrl: runtime.qrUrl,
      connectUrl: runtime.connectUrl,
      workspacePath: target.workspacePath,
      workspaceIdentity: target.workspaceIdentity,
      remoteSessionId: target.remoteSessionId,
      initialTaskId: runtime.currentBridge?.initialTaskId ?? runtime.initialTaskId,
      error: runtime.error,
      failure: runtime.failure,
      repairRequired: runtime.repairRequired,
    };
  }

  function emitRuntimeStatus(runtime: WindowControlRuntime): void {
    dependencies.onStatusChanged?.(runtime.windowId, buildRuntimeStatus(runtime));
  }

  function clearMobileTaskView(runtime: WindowControlRuntime): void {
    if (!runtime.mobileTaskView) return;
    runtime.mobileTaskView = undefined;
    emitRuntimeStatus(runtime);
  }

  function requestMobileTaskView(runtime: WindowControlRuntime): void {
    if (runtime.transportState !== "paired" || !runtime.mobileTaskViewEpoch) return;
    sendAppPayload(runtime, {
      zcode_type: "mobile-task-view-request",
      epoch: runtime.mobileTaskViewEpoch,
    });
  }

  function emitIdleStatus(windowId: number): void {
    dependencies.onStatusChanged?.(windowId, { status: "idle" });
  }

  function scheduleMobileDisconnectGrace(runtime: WindowControlRuntime): void {
    if (runtime.mobileDisconnectGraceTimer) {
      return;
    }
    runtime.mobileDisconnectGraceTimer = setTimeout(() => {
      runtime.mobileDisconnectGraceTimer = undefined;
      if (runtimes.get(runtime.windowId) !== runtime || runtime.status === "error") {
        return;
      }
      runtime.status = "running";
      runtime.mobileConnected = false;
      emitRuntimeStatus(runtime);
    }, MOBILE_DISCONNECT_STATUS_GRACE_MS);
  }

  function schedulePendingOutboundPayloadTimeout(runtime: WindowControlRuntime): void {
    if (runtime.pendingOutboundPayloadTimer || runtime.pendingOutboundPayloads.length === 0) {
      return;
    }
    runtime.pendingOutboundPayloadTimer = setTimeout(() => {
      runtime.pendingOutboundPayloadTimer = undefined;
      const droppedCount = runtime.pendingOutboundPayloads.splice(0).length;
      dependencies.logger.warn("[web-remote-control] dropped buffered outbound payloads", {
        windowId: runtime.windowId,
        session: runtime.deviceSid,
        droppedCount,
      });
    }, WEB_REMOTE_CONTROL_OUTBOUND_PAYLOAD_BUFFER_TIMEOUT_MS);
  }

  function sendPayloadToTransport(
    runtime: WindowControlRuntime,
    payload: WebRemoteControlAppPayload,
  ): WebRemoteControlPayloadSendResult {
    if (runtime.transport.sendPayloadResult) {
      return runtime.transport.sendPayloadResult(payload);
    }
    return runtime.transport.sendPayload(payload)
      ? { kind: "sent", bytes: 0 }
      : { kind: "unavailable" };
  }

  function sendPendingBridgeInvalidation(runtime: WindowControlRuntime): void {
    const payload = runtime.pendingBridgeInvalidation;
    if (!payload) return;
    const result = sendPayloadToTransport(runtime, payload);
    if (result.kind === "oversize") {
      dependencies.logger.error("[web-remote-control] bridge invalidation is oversized", {
        bridgeSessionId: payload.bridgeSessionId,
        bytes: result.bytes,
        maxBytes: result.maxBytes,
      });
    }
    // Keep the latch while unavailable; keep it after sent as well, until the phone issues open with a new bridge identity.
  }

  function bufferOutboundPayload(
    runtime: WindowControlRuntime,
    payload: WebRemoteControlAppPayload,
  ): void {
    if (runtime.pendingOutboundPayloads.length >= 50) {
      const droppedCount = runtime.pendingOutboundPayloads.length + 1;
      runtime.pendingOutboundPayloads.length = 0;
      clearPendingOutboundPayloadTimer(runtime);
      dependencies.logger.warn("[web-remote-control] dropped overflowing outbound payloads", {
        windowId: runtime.windowId,
        session: runtime.deviceSid,
        droppedCount,
      });
      return;
    }
    runtime.pendingOutboundPayloads.push(payload);
    schedulePendingOutboundPayloadTimeout(runtime);
  }

  function flushPendingOutboundPayloads(runtime: WindowControlRuntime): void {
    while (runtime.pendingOutboundPayloads.length > 0) {
      const payload = runtime.pendingOutboundPayloads[0];
      if (!payload) {
        break;
      }
      const result = sendPayloadToTransport(runtime, payload);
      if (result.kind === "unavailable") {
        schedulePendingOutboundPayloadTimeout(runtime);
        return;
      }
      if (result.kind === "oversize") {
        // Bugfix: a permanent oversize must not masquerade as temporarily unsendable and repeatedly enter the 50-item buffer.
        dependencies.logger.warn("[web-remote-control] dropped oversize app payload", {
          zcodeType: payload.zcode_type,
          bytes: result.bytes,
          maxBytes: result.maxBytes,
        });
      }
      runtime.pendingOutboundPayloads.shift();
    }
    clearPendingOutboundPayloadTimer(runtime);
  }

  function sendAppPayload(
    runtime: WindowControlRuntime,
    payload: WebRemoteControlAppPayload,
  ): void {
    if (runtime.pendingOutboundPayloads.length > 0) {
      bufferOutboundPayload(runtime, payload);
      flushPendingOutboundPayloads(runtime);
      return;
    }
    const result = sendPayloadToTransport(runtime, payload);
    if (result.kind === "sent") {
      return;
    }
    if (result.kind === "oversize") {
      dependencies.logger.warn("[web-remote-control] rejected oversize app payload", {
        zcodeType: payload.zcode_type,
        bytes: result.bytes,
        maxBytes: result.maxBytes,
      });
      return;
    }
    // Bugfix: sendPayload returns false inside the relay suspect window.
    // Response/RPC frames sent by the desktop must not be dropped silently; buffer them briefly and flush once paired recovers.
    bufferOutboundPayload(runtime, payload);
  }

  function preserveWindowRuntimeFailure(
    windowId: number,
    runtime: WindowControlRuntime,
    reason: string,
    failure: WebRemoteControlFailure,
  ): void {
    if (runtime.status === "error" && runtime.failure?.reason === failure.reason) {
      return;
    }

    sendAppPayload(runtime, {
      zcode_type: "app-error",
      reason: failure.reason,
      error: failure.message ?? failure.reason,
    });
    cancelBridgeOpen(runtime);
    disposeRuntimeBridgeResources(runtime);
    clearPendingOutboundPayloadTimer(runtime);
    clearMobileDisconnectGraceTimer(runtime);
    runtime.pendingOutboundPayloads.length = 0;
    runtime.transport.dispose();
    runtime.status = "error";
    runtime.mobileConnected = false;
    runtime.error = failure.message;
    runtime.failure = failure;
    runtimes.set(windowId, runtime);
    dependencies.logger.warn(
      `[web-remote-control] runtime closed window=${windowId} session=${runtime.deviceSid} reason=${reason} failure=${failure.reason} message=${failure.message ?? "<none>"}`,
    );
    emitRuntimeStatus(runtime);
  }

  async function stopWindowRuntime(windowId: number, reason: string): Promise<void> {
    windowLifecycles.get(windowId)?.controller.abort();
    windowLifecycles.delete(windowId);
    const runtime = runtimes.get(windowId);
    if (!runtime) {
      return;
    }

    sendAppPayload(runtime, {
      zcode_type: "app-error",
      reason: "desktop-disconnected",
      error: "Desktop disconnected this Web remote control session.",
    });
    runtimes.delete(windowId);
    pushedWorkspaceListSignaturesByWindowId.delete(windowId);
    cancelBridgeOpen(runtime);
    disposeRuntimeBridgeResources(runtime);
    clearPendingOutboundPayloadTimer(runtime);
    clearMobileDisconnectGraceTimer(runtime);
    runtime.pendingOutboundPayloads.length = 0;
    runtime.transport.dispose();
    dependencies.disposeWorkspaceHostAttachmentsForWindow(windowId, reason);

    dependencies.logger.info(
      `[web-remote-control] stopped window=${windowId} session=${runtime.deviceSid} reason=${reason}`,
    );
    emitIdleStatus(windowId);
  }

  function requireAuthentication(windowId: number): void {
    // A relay JWT rejected by the relay must not be reused for the next attempt.
    dependencies.relayBearer?.invalidate();
    void stopWindowRuntime(windowId, "auth-required");
    authRequiredWindows.add(windowId);
    startupRestoreClaimed = false;
    dependencies.onStatusChanged?.(windowId, { status: "auth-required" });
  }

  function getRuntimeWorkspaceTarget(
    runtime: WindowControlRuntime,
  ): WebRemoteControlWorkspaceTarget {
    const bridge = runtime.currentBridge;
    if (bridge) {
      return {
        workspacePath: bridge.workspacePath,
        workspaceIdentity: bridge.workspaceIdentity,
        remoteSessionId: bridge.remoteSessionId,
        label: getPathLabel(bridge.workspacePath),
        kind: bridge.kind,
      };
    }

    return {
      workspacePath: runtime.workspacePath,
      workspaceIdentity: runtime.workspaceIdentity,
      remoteSessionId: runtime.remoteSessionId,
      label: getPathLabel(runtime.workspacePath),
      kind: runtime.remoteSessionId || runtime.workspaceIdentity ? "remote" : "local",
    };
  }

  function getRuntimeStatusTarget(runtime: WindowControlRuntime): WebRemoteControlWorkspaceTarget {
    // Bugfix: the phone can switch to another workspace in the window within the same remote-control session.
    // Previously getStatus() reused the current bridge target, so when the desktop popup polled by the launch workspace it misjudged the session as different,
    // and reopening the popup restarted remote control and kicked the phone offline. The status endpoint keeps the original target of the window's remote-control session,
    // while the phone's current workspace is still expressed through mobileViewState / the workspace list.
    return {
      workspacePath: runtime.workspacePath,
      workspaceIdentity: runtime.workspaceIdentity,
      remoteSessionId: runtime.remoteSessionId,
      label: getPathLabel(runtime.workspacePath),
      kind: runtime.remoteSessionId || runtime.workspaceIdentity ? "remote" : "local",
    };
  }

  function getAvailableWorkspaces(
    runtime: WindowControlRuntime,
  ): WebRemoteControlWorkspaceTarget[] {
    const workspaceByKey = new Map<string, WebRemoteControlWorkspaceTarget>();

    for (const workspace of availableWorkspacesByWindowId.get(runtime.windowId) ?? []) {
      // Bugfix: the phone's workspace list must show disconnected SSH projects exactly as the desktop does.
      // Only the list entry is kept here; creating a bridge still validates remoteSessionId, so an unconnected project cannot be opened straight into chat.
      workspaceByKey.set(resolveWebRemoteControlWorkspaceKey(workspace), workspace);
    }

    const currentTarget = getRuntimeWorkspaceTarget(runtime);
    if (isBridgeableRemoteTarget(currentTarget)) {
      const currentKey = resolveWebRemoteControlWorkspaceKey(currentTarget);
      if (!workspaceByKey.has(currentKey)) {
        workspaceByKey.set(currentKey, currentTarget);
      }
    }

    return [...workspaceByKey.values()];
  }

  function getRuntimeInitialViewState(
    runtime: WindowControlRuntime,
  ): WebRemoteControlMobileViewState | undefined {
    const activeTarget = getRuntimeWorkspaceTarget(runtime);
    if (!runtime.initialTaskId || !isBridgeableRemoteTarget(activeTarget)) {
      return undefined;
    }

    return {
      activeWorkspaceKey: resolveWebRemoteControlWorkspaceKey(activeTarget),
      activeTaskId: runtime.initialTaskId,
      updatedAt: Date.now(),
    };
  }

  function buildBootstrapResult(
    runtime: WindowControlRuntime,
  ): WebRemoteControlWindowBootstrapResult {
    return {
      windowControlSessionId: runtime.deviceSid,
      desktopAppVersion: dependencies.appVersion,
      workspaces: getAvailableWorkspaces(runtime),
      // Task-list sync was replaced by the mobile task view in relay V2; the list stays empty for older phone clients.
      tasks: [],
      initialViewState: getRuntimeInitialViewState(runtime),
      mobileViewState: runtime.mobileViewState,
      mobileTaskViewEpoch: runtime.mobileTaskViewEpoch,
    };
  }

  function buildWorkspaceListResult(
    runtime: WindowControlRuntime,
  ): WebRemoteControlWorkspaceListResult {
    const activeTarget = getRuntimeWorkspaceTarget(runtime);
    const initialViewState = getRuntimeInitialViewState(runtime);
    return {
      workspaces: getAvailableWorkspaces(runtime),
      activeWorkspaceKey:
        runtime.mobileViewState?.activeWorkspaceKey ??
        initialViewState?.activeWorkspaceKey ??
        resolveWebRemoteControlWorkspaceKey(activeTarget),
      activeTaskId:
        runtime.mobileViewState?.activeTaskId ??
        runtime.currentBridge?.initialTaskId ??
        initialViewState?.activeTaskId,
    };
  }

  function buildWorkspaceListPushSignature(result: WebRemoteControlWorkspaceListResult): string {
    const workspaceSignatureEntries = result.workspaces
      .map((workspace) => {
        const workspaceKey = resolveWebRemoteControlWorkspaceKey(workspace);
        return JSON.stringify([
          workspaceKey,
          workspace.kind,
          workspace.connectionState ?? "connected",
          workspace.remoteSessionId ?? "",
          // Bugfix: connection state is more than the enum value; the error reason can also change within the same disconnected state,
          // and the phone's workspace card displays lastConnectionError directly, so it must trigger a new snapshot.
          workspace.lastConnectionError ?? "",
        ]);
      })
      .sort();

    // Bugfix: title and connection error are arbitrary user-visible strings and must not be joined into a tuple with control characters;
    // otherwise two different snapshots could produce the same signature when a field value contains the separator. A JSON tuple keeps field boundaries and still ignores array order.
    return JSON.stringify(workspaceSignatureEntries);
  }

  function pushWorkspaceListUpdated(runtime: WindowControlRuntime): void {
    const result = buildWorkspaceListResult(runtime);
    const signature = buildWorkspaceListPushSignature(result);
    if (pushedWorkspaceListSignaturesByWindowId.get(runtime.windowId) === signature) {
      return;
    }

    pushedWorkspaceListSignaturesByWindowId.set(runtime.windowId, signature);
    sendAppPayload(runtime, {
      zcode_type: "workspace-list-updated",
      result,
    });
  }

  async function respondToPlatformRequest(
    runtime: WindowControlRuntime,
    request: WebRemoteControlPlatformRequestPayload,
  ): Promise<void> {
    let response: WebRemoteControlPlatformResponsePayload;

    try {
      const result = await dependencies.platformHandlers[request.method](request.args as never);
      response = {
        zcode_type: "platform-response",
        requestId: request.requestId,
        method: request.method,
        success: true,
        result,
      } as WebRemoteControlPlatformResponsePayload;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      dependencies.logger.warn(
        `[web-remote-control] platform request failed window=${runtime.windowId} session=${runtime.deviceSid} method=${request.method} error=${message}`,
      );
      response = {
        zcode_type: "platform-response",
        requestId: request.requestId,
        method: request.method,
        success: false,
        error: message,
      };
    }

    sendAppPayload(runtime, response);
  }

  function cancelBridgeOpen(runtime: WindowControlRuntime): void {
    const pending = runtime.bridgeOpen;
    runtime.bridgeOpen = undefined;
    if (pending?.preparingProject)
      dependencies.cancelProjectPreparation?.(runtime.windowId, pending.hostRequestId);
  }

  function createWorkspaceBridge(
    runtime: WindowControlRuntime,
    request: WebRemoteControlWorkspaceBridgeOpenPayload,
  ): Promise<WebRemoteControlExternalWorkspaceBridge> {
    const intentKey = JSON.stringify([
      request.workspaceKey,
      request.taskId ?? null,
      request.project?.projectId,
      request.project?.hostId,
      request.project?.draftId,
      request.taskHostId,
      request.fileTreeTaskId,
    ]);
    const previous = runtime.bridgeOpen;
    if (
      previous?.bridgeSessionId === request.bridgeSessionId &&
      previous.bridgeGeneration === request.bridgeGeneration
    ) {
      if (previous.intentKey !== intentKey)
        return Promise.reject(new Error("Workspace bridge identity cannot change intent."));
      if (
        runtime.currentBridge?.degraded ||
        (runtime.pendingBridgeInvalidation?.bridgeSessionId === request.bridgeSessionId &&
          runtime.pendingBridgeInvalidation.bridgeGeneration === request.bridgeGeneration)
      )
        return Promise.reject(new Error("Degraded workspace bridge requires a new identity."));
      return previous.promise;
    }
    cancelBridgeOpen(runtime);
    // Retries with the same transport identity reuse the whole admission; a new navigation immediately invalidates old async results.
    const pending: NonNullable<WindowControlRuntime["bridgeOpen"]> = {
      bridgeSessionId: request.bridgeSessionId,
      bridgeGeneration: request.bridgeGeneration,
      intentKey,
      hostRequestId: randomUUID(),
      preparingProject: Boolean(request.project || request.taskHostId),
      promise: undefined as never,
    };
    runtime.bridgeOpen = pending;
    pending.promise = buildWorkspaceBridge(runtime, request, pending);
    return pending.promise;
  }

  async function buildWorkspaceBridge(
    runtime: WindowControlRuntime,
    request: WebRemoteControlWorkspaceBridgeOpenPayload,
    pending: NonNullable<WindowControlRuntime["bridgeOpen"]>,
  ): Promise<WebRemoteControlExternalWorkspaceBridge> {
    let target: WebRemoteControlWorkspaceTarget | undefined;
    const intent: HostProjectWorkspaceNavigationInput | undefined =
      request.project ??
      ((request.fileTreeTaskId || request.taskId) && request.taskHostId
        ? {
            hostId: request.taskHostId,
            task: {
              taskId: (request.fileTreeTaskId ?? request.taskId)!,
              workspaceKey: request.workspaceKey,
            },
          }
        : undefined);
    if (intent) {
      if ((request.project && request.taskId) || !dependencies.prepareProjectWorkspace)
        throw new Error("Project navigation is unavailable.");
      try {
        const prepared = await dependencies.prepareProjectWorkspace(
          runtime.windowId,
          intent,
          pending.hostRequestId,
        );
        target = {
          workspacePath: prepared.workspacePath,
          workspaceIdentity: prepared.workspaceIdentity,
          remoteSessionId: prepared.remote?.remoteSessionId,
          kind: prepared.remote ? "remote" : "local",
          label: prepared.workspacePath,
          ...(prepared.remote ? { connectionState: "connected" as const } : {}),
        };
      } finally {
        pending.preparingProject = false;
      }
    } else {
      target = getAvailableWorkspaces(runtime).find(
        (workspace) => resolveWebRemoteControlWorkspaceKey(workspace) === request.workspaceKey,
      );
    }
    if (runtimes.get(runtime.windowId) !== runtime || runtime.bridgeOpen !== pending)
      throw new Error("Workspace bridge request was superseded.");
    if (!target) {
      throw new Error(
        "The target workspace is not in the current desktop window; cannot create the Web remote control bridge.",
      );
    }
    if (!isBridgeableRemoteTarget(target)) {
      throw new Error(
        "The target remote workspace is not connected; cannot create the bridge. Reconnect first.",
      );
    }
    const targetWorkspaceKey = resolveWebRemoteControlWorkspaceKey(target);

    const invalidation = runtime.pendingBridgeInvalidation;
    if (
      invalidation?.bridgeSessionId === request.bridgeSessionId &&
      invalidation.bridgeGeneration === request.bridgeGeneration
    ) {
      throw new Error("Degraded workspace bridge must be rebuilt with a new transport identity.");
    }
    // An open with a new identity has proven the phone consumed the invalidation; later failures are closed by an explicit bridge-error
    // and the Web side's bounded retry, so the old generation's degraded notice is not repeated.
    runtime.pendingBridgeInvalidation = undefined;

    disposeRuntimeBridgeResources(runtime);
    runtime.status = "connecting";
    runtime.error = undefined;
    runtime.failure = undefined;
    emitRuntimeStatus(runtime);

    const bridgeRuntime: WorkspaceBridgeRuntime = {
      bridgeSessionId: request.bridgeSessionId,
      bridgeGeneration: request.bridgeGeneration,
      recoveryId: request.recoveryId,
      hostEntryId: "",
      attachmentId: "",
      kind: target.kind,
      workspaceKey: targetWorkspaceKey,
      workspacePath: target.workspacePath,
      workspaceIdentity: target.workspaceIdentity,
      remoteSessionId: target.remoteSessionId,
      initialTaskId: request.taskId,
      readyAnnounced: false,
      degraded: false,
    };
    runtime.currentBridge = bridgeRuntime;

    dependencies.logger.info(
      `[web-remote-control] attaching workspace bridge window=${runtime.windowId} session=${runtime.deviceSid} bridgeSession=${request.bridgeSessionId} workspace=${target.workspacePath}`,
    );

    let acquired: WebRemoteControlHostAttachmentHandle | undefined;
    try {
      acquired = await dependencies.attachWorkspaceHost(runtime.windowId, {
        workspacePath: target.workspacePath,
        workspaceIdentity: target.workspaceIdentity,
        remoteSessionId: target.remoteSessionId,
        initialTaskId: request.taskId,
        kind: target.kind,
      });
      if (!isCurrentBridgeRuntime(runtime, bridgeRuntime) || runtime.bridgeOpen !== pending) {
        dependencies.releaseWorkspaceHostAttachment(acquired.attachmentId);
        acquired = undefined;
        throw new Error("Workspace bridge request was superseded.");
      }
      const hostProtocol = new MessagePortProtocol(wrapElectronPort(acquired.port));
      const relayProtocol = createAcknowledgedWebRemoteControlRelayProtocol({
        bridgeSessionId: bridgeRuntime.bridgeSessionId,
        bridgeGeneration: bridgeRuntime.bridgeGeneration,
        recoveryId: bridgeRuntime.recoveryId,
        measureFrameBytes: (frame) =>
          runtime.transport.measurePayloadBytes?.(frame) ??
          measureWebRemoteControlRpcRelayEnvelopeBytes(frame),
        sendFrame: (payload) => {
          if (!bridgeRuntime.readyAnnounced || bridgeRuntime.degraded) return false;
          const result = sendPayloadToTransport(runtime, payload);
          if (result.kind === "oversize") {
            throw new Error("remote.rpcFrame.envelopeTooLarge");
          }
          return result.kind === "sent";
        },
      });

      // Bugfix: the raw adapter is the only replay owner; main no longer puts rpc-frames into the ordinary 50-item buffer.
      const disposeHostToRelay = hostProtocol.onMessage((buffer) => {
        relayProtocol.protocol.send(buffer);
      });
      const disposeRelayToHost = relayProtocol.protocol.onMessage((buffer) => {
        hostProtocol.send(buffer);
      });
      const disposeDegraded = relayProtocol.onDegraded((fault) => {
        degradeBridgeAfterRawFault(runtime, bridgeRuntime, fault.reasonCode);
      });
      const disposeSaturated = relayProtocol.onSaturated(() => {
        if (!isCurrentBridgeRuntime(runtime, bridgeRuntime) || bridgeRuntime.degraded) return;
        hostProtocol.sendFlowState("saturated");
      });
      const disposeDrained = relayProtocol.onDrained(() => {
        if (!isCurrentBridgeRuntime(runtime, bridgeRuntime) || bridgeRuntime.degraded) return;
        hostProtocol.sendFlowState("drained");
      });

      bridgeRuntime.hostEntryId = acquired.entryId;
      bridgeRuntime.attachmentId = acquired.attachmentId;
      bridgeRuntime.hostProtocol = hostProtocol;
      bridgeRuntime.relayProtocol = relayProtocol;
      bridgeRuntime.disposeBridge = () => {
        disposeHostToRelay.dispose();
        disposeRelayToHost.dispose();
        disposeDegraded.dispose();
        disposeSaturated.dispose();
        disposeDrained.dispose();
      };
      runtime.status = "active";
      runtime.error = undefined;
      runtime.failure = undefined;
      emitRuntimeStatus(runtime);

      dependencies.logger.info(
        `[web-remote-control] workspace bridge active window=${runtime.windowId} session=${runtime.deviceSid} bridgeSession=${request.bridgeSessionId}`,
      );
      reportRemoteUsageEvent(
        runtime.windowId,
        buildWebRemoteControlBridgeResultTelemetry({
          result: "success",
          workspaceKind: target.kind,
          remoteKind: resolveRemoteKind(target, acquired),
          entryKind: request.taskId ? "task" : "home",
        }),
      );

      return toExternalBridge(bridgeRuntime);
    } catch (error) {
      reportRemoteUsageEvent(
        runtime.windowId,
        buildWebRemoteControlBridgeResultTelemetry({
          result: "failure",
          workspaceKind: target.kind,
          remoteKind: resolveRemoteKind(target, acquired),
          entryKind: request.taskId ? "task" : "home",
          errorCategory: classifyRemoteUsageError(error),
        }),
      );
      if (acquired) {
        dependencies.releaseWorkspaceHostAttachment(acquired.attachmentId);
      }
      if (isCurrentBridgeRuntime(runtime, bridgeRuntime)) {
        disposeRuntimeBridgeResources(runtime);
        runtime.status = runtime.mobileConnected ? "active" : "running";
        emitRuntimeStatus(runtime);
      }
      throw error;
    }
  }

  async function respondToWorkspaceBridgeOpen(
    runtime: WindowControlRuntime,
    request: WebRemoteControlWorkspaceBridgeOpenPayload,
  ): Promise<void> {
    try {
      const bridge = await createWorkspaceBridge(runtime, request);
      sendAppPayload(runtime, {
        zcode_type: "workspace-bridge-ready",
        requestId: request.requestId,
        bridgeSessionId: request.bridgeSessionId,
        ...(request.bridgeGeneration !== undefined
          ? { bridgeGeneration: request.bridgeGeneration }
          : {}),
        ...(request.recoveryId ? { recoveryId: request.recoveryId } : {}),
        bridge,
      });
      const currentBridge = runtime.currentBridge;
      if (
        currentBridge?.bridgeSessionId === request.bridgeSessionId &&
        currentBridge.bridgeGeneration === request.bridgeGeneration
      ) {
        // bridge-ready must enter the ordinary app transport first before queued raw frames are allowed through.
        currentBridge.readyAnnounced = true;
        currentBridge.relayProtocol?.flushPendingFrames();
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      dependencies.logger.warn(
        `[web-remote-control] workspace bridge failed window=${runtime.windowId} session=${runtime.deviceSid} workspaceKey=${request.workspaceKey} error=${message}`,
      );
      sendAppPayload(runtime, {
        zcode_type: "workspace-bridge-error",
        requestId: request.requestId,
        bridgeSessionId: request.bridgeSessionId,
        ...(request.bridgeGeneration !== undefined
          ? { bridgeGeneration: request.bridgeGeneration }
          : {}),
        ...(request.recoveryId ? { recoveryId: request.recoveryId } : {}),
        reason: mapWorkspaceBridgeFailureReason(error),
        error: message,
      });
    }
  }

  async function respondToWorkspaceReconnectRequest(
    runtime: WindowControlRuntime,
    request: Extract<WebRemoteControlAppPayload, { zcode_type: "workspace-reconnect-request" }>,
  ): Promise<void> {
    try {
      await dependencies.reconnectWorkspace(runtime.windowId, request.workspaceKey);
      sendAppPayload(runtime, {
        zcode_type: "workspace-reconnect-response",
        requestId: request.requestId,
        workspaceKey: request.workspaceKey,
        success: true,
      });
    } catch (error) {
      sendAppPayload(runtime, {
        zcode_type: "workspace-reconnect-response",
        requestId: request.requestId,
        workspaceKey: request.workspaceKey,
        success: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async function respondToWorkspaceOpenRequest(
    runtime: WindowControlRuntime,
    request: WebRemoteControlWorkspaceOpenRequestPayload,
  ): Promise<void> {
    let response: WebRemoteControlWorkspaceOpenResponsePayload;
    try {
      await dependencies.openWorkspace(runtime.windowId, {
        workspacePath: request.workspacePath,
        ...(request.workspaceIdentity ? { workspaceIdentity: request.workspaceIdentity } : {}),
      });
      response = {
        zcode_type: "workspace-open-response",
        requestId: request.requestId,
        workspacePath: request.workspacePath,
        ...(request.workspaceIdentity ? { workspaceIdentity: request.workspaceIdentity } : {}),
        success: true,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      dependencies.logger.warn(
        `[web-remote-control] workspace open failed window=${runtime.windowId} session=${runtime.deviceSid} workspacePath=${request.workspacePath} error=${message}`,
      );
      response = {
        zcode_type: "workspace-open-response",
        requestId: request.requestId,
        workspacePath: request.workspacePath,
        ...(request.workspaceIdentity ? { workspaceIdentity: request.workspaceIdentity } : {}),
        success: false,
        error: message,
      };
    }

    sendAppPayload(runtime, response);
  }

  function applyMobileViewStateUpdate(
    runtime: WindowControlRuntime,
    viewState: WebRemoteControlMobileViewState,
    deviceInfo?: WebRemoteControlMobileDeviceInfo,
  ): void {
    runtime.mobileViewState = viewState;
    if (deviceInfo) {
      runtime.mobileDeviceInfo = deviceInfo;
    }
  }

  function applyMobileTaskViewUpdate(
    runtime: WindowControlRuntime,
    payload: WebRemoteControlMobileTaskViewUpdatePayload,
  ): void {
    const bridge = runtime.currentBridge;
    const view = payload.view;
    // Navigation cache, disconnect grace, and stale bridge replies cannot prove current viewing; only a full address from this generation's pairing is accepted.
    if (
      runtime.transportState !== "paired" ||
      payload.epoch !== runtime.mobileTaskViewEpoch ||
      payload.seq <= (runtime.mobileTaskViewSeq ?? -1) ||
      !bridge?.readyAnnounced ||
      bridge.degraded ||
      payload.bridgeSessionId !== bridge.bridgeSessionId ||
      payload.bridgeGeneration !== bridge.bridgeGeneration ||
      (view &&
        (view.workspacePath !== bridge.workspacePath ||
          resolveWebRemoteControlWorkspaceKey(view) !== bridge.workspaceKey))
    )
      return;
    runtime.mobileTaskViewSeq = payload.seq;
    // A legacy identity cannot be reversed to a Source; reads and CAS must carry the trusted session of the owning bridge and must not accept self-reported Web data.
    const trustedView = view
      ? {
          ...view,
          ...(bridge.kind === "remote" ? { remoteSessionId: bridge.remoteSessionId } : {}),
        }
      : undefined;
    const previous = runtime.mobileTaskView;
    if (
      previous?.taskId === trustedView?.taskId &&
      previous?.workspacePath === trustedView?.workspacePath &&
      previous?.workspaceIdentity === trustedView?.workspaceIdentity &&
      previous?.remoteSessionId === trustedView?.remoteSessionId
    )
      return;
    runtime.mobileTaskView = trustedView;
    emitRuntimeStatus(runtime);
  }

  function routeRpcTransportPayload(
    runtime: WindowControlRuntime,
    frame: WebRemoteControlRpcTransportPayload,
  ): void {
    routeRawTransportCandidate(runtime, frame);
  }

  function routeRawTransportCandidate(runtime: WindowControlRuntime, payload: unknown): boolean {
    const bridge = runtime.currentBridge;
    if (!bridge || bridge.degraded) return false;
    return bridge.relayProtocol?.acceptPayload(payload) ?? false;
  }

  function logMobileDiagnostic(
    runtime: WindowControlRuntime,
    payload: Extract<WebRemoteControlAppPayload, { zcode_type: "mobile-diagnostic" }>,
  ): void {
    dependencies.logger.info("[web-remote-control] mobile diagnostic", {
      window: runtime.windowId,
      session: runtime.deviceSid,
      event: payload.event,
      state: payload.state,
      previousState: payload.previousState,
      pairStatus: payload.pairStatus,
      closeCode: payload.closeCode,
      closeReason: payload.closeReason,
      wasClean: payload.wasClean,
      wasPaired: payload.wasPaired,
      failureReason: payload.failureReason,
      failureMessage: payload.failureMessage,
      visibilityState: payload.visibilityState,
      online: payload.online,
      hiddenDurationMs: payload.hiddenDurationMs,
      timestamp: payload.timestamp,
    });
  }

  function routePayload(runtime: WindowControlRuntime, payload: WebRemoteControlAppPayload): void {
    switch (payload.zcode_type) {
      case "bootstrap-request":
        sendAppPayload(runtime, {
          zcode_type: "bootstrap-response",
          requestId: payload.requestId,
          success: true,
          result: buildBootstrapResult(runtime),
        });
        break;
      case "workspace-list-request":
        sendAppPayload(runtime, {
          zcode_type: "workspace-list-response",
          requestId: payload.requestId,
          success: true,
          result: buildWorkspaceListResult(runtime),
        });
        break;
      case "platform-request":
        void respondToPlatformRequest(runtime, payload);
        break;
      case "mobile-view-state-update":
        applyMobileViewStateUpdate(runtime, payload.viewState, payload.deviceInfo);
        break;
      case "mobile-task-view-update":
        applyMobileTaskViewUpdate(runtime, payload);
        break;
      case "workspace-bridge-open":
        void respondToWorkspaceBridgeOpen(runtime, payload);
        break;
      case "workspace-reconnect-request":
        void respondToWorkspaceReconnectRequest(runtime, payload);
        break;
      case "workspace-open-request":
        void respondToWorkspaceOpenRequest(runtime, payload);
        break;
      case "rpc-frame":
      case "rpc-frame-ack":
        routeRpcTransportPayload(runtime, payload);
        break;
      case "telemetry-report":
        // The phone already builds the event at the creation boundary; Main only forwards it and maintains no session facts or interference with the replayable link.
        dependencies.reportRendererTelemetryEvent?.(payload.event);
        break;
      case "mobile-diagnostic":
        logMobileDiagnostic(runtime, payload);
        break;
      default:
        break;
    }
  }

  function mapTransportState(
    runtime: WindowControlRuntime,
    state: WebRemoteControlDeviceTransportState,
  ): void {
    const previousTransportState = runtime.transportState;
    runtime.transportState = state;
    // Transient viewing must not reuse the connection dialog's disconnect grace; recovery must be re-declared by a visible page under the new epoch.
    if (state !== "paired") {
      runtime.mobileTaskViewEpoch = undefined;
      runtime.mobileTaskViewSeq = undefined;
      clearMobileTaskView(runtime);
    } else if (previousTransportState !== "paired") {
      runtime.mobileTaskViewEpoch = randomUUID();
      runtime.mobileTaskViewSeq = -1;
    }
    if (state !== "paired") {
      runtime.hasObservedSendReadyForPairing = false;
    }
    if (state === "waiting_terminal" || state === "paired") {
      runtime.error = undefined;
      runtime.failure = undefined;
    }
    // The re-pair notice stays until a phone actually pairs; waiting_terminal alone does not clear it.
    if (state === "paired") {
      runtime.repairRequired = false;
    }
    if (state === "connecting" || state === "authenticating") {
      if (runtime.mobileConnected) {
        // Bugfix: a brief relay flap on an already paired session first passes through connecting/authenticating.
        // The old logic switched the dialog to "starting" immediately, so users thought remote control restarted; stay active within the grace window here.
        runtime.status = "active";
        scheduleMobileDisconnectGrace(runtime);
        emitRuntimeStatus(runtime);
        return;
      }
      runtime.status = "starting";
      emitRuntimeStatus(runtime);
      return;
    }
    if (state === "waiting_terminal") {
      if (runtime.mobileConnected) {
        // Bugfix: when an already paired session recovers, the relay may briefly fall back to waiting.
        // The old logic pulled the dialog from active back to "waiting for phone pairing"; debounce first here and degrade only if still unpaired after the timeout.
        runtime.status = "active";
        scheduleMobileDisconnectGrace(runtime);
        emitRuntimeStatus(runtime);
        return;
      }
      runtime.status = "running";
      runtime.mobileConnected = false;
      emitRuntimeStatus(runtime);
      return;
    }
    if (state === "paired") {
      if (previousTransportState !== "paired") {
        const workspaceDimensions = resolveRuntimeWorkspaceDimensions(runtime);
        reportRemoteUsageEvent(
          runtime.windowId,
          buildWebRemoteControlPairResultTelemetry({
            result: "success",
            pairKind: runtime.hasEverPaired ? "reconnect" : "initial",
            ...workspaceDimensions,
          }),
        );
      }
      runtime.hasEverPaired = true;
      clearMobileDisconnectGraceTimer(runtime);
      runtime.status = "active";
      runtime.mobileConnected = true;
      emitRuntimeStatus(runtime);
      // Bugfix: when an ordinary disconnect-reconnect pairs again, the transport does not necessarily fire onSendReady.
      // Flush proactively once the state is sendable again, so response/RPC frames buffered in the reconnect window are not dropped on timeout.
      flushPendingOutboundPayloads(runtime);
      sendPendingBridgeInvalidation(runtime);
      if (previousTransportState !== "paired") requestMobileTaskView(runtime);
      return;
    }
    if (state === "kicked") {
      if (previousTransportState !== "kicked") {
        const workspaceDimensions = resolveRuntimeWorkspaceDimensions(runtime);
        reportRemoteUsageEvent(
          runtime.windowId,
          buildWebRemoteControlPairResultTelemetry({
            result: "failure",
            pairKind: runtime.hasEverPaired ? "reconnect" : "initial",
            ...workspaceDimensions,
            errorCategory: "relay",
          }),
        );
      }
      preserveWindowRuntimeFailure(
        runtime.windowId,
        runtime,
        "external-relay-kicked",
        createFailure("session-conflict", "Web remote control connection was kicked by relay."),
      );
      return;
    }
    if (state === "error") {
      if (previousTransportState !== "error") {
        const workspaceDimensions = resolveRuntimeWorkspaceDimensions(runtime);
        reportRemoteUsageEvent(
          runtime.windowId,
          buildWebRemoteControlPairResultTelemetry({
            result: "failure",
            pairKind: runtime.hasEverPaired ? "reconnect" : "initial",
            ...workspaceDimensions,
            errorCategory: "relay",
          }),
        );
      }
      runtime.status = "error";
      emitRuntimeStatus(runtime);
    }
  }

  function createQrUrl(deviceSid: string, mobileRemoteControlUrl: string): string {
    return buildWebRemoteControlExternalQrUrl({
      baseUrl: mobileRemoteControlUrl,
      deviceSid,
      deviceMid: dependencies.deviceMid,
      deviceName: dependencies.deviceName,
      appVersion: dependencies.appVersion,
    });
  }

  return {
    authorizeStart,
    async startAuthorized(
      windowId: number,
      context: WebRemoteControlContext,
      authorization: WebRemoteControlStartAuthorization,
    ): Promise<WebRemoteControlStartResult> {
      consumeStartAuthorization(windowId, context, authorization);
      return this.start(windowId, context);
    },
    async start(
      windowId: number,
      context: WebRemoteControlContext,
      startOptions: { forceRegistration?: boolean } = {},
    ): Promise<WebRemoteControlStartResult> {
      const forceRegistration = startOptions.forceRegistration === true;
      clearStartAuthorizationsForWindow(windowId);
      dependencies.featureGate.assertEnabled();
      startupRestoreClaimed = true;
      const stopped = stopWindowRuntime(windowId, "restart");
      const controller = new AbortController();
      const lifecycle: WindowControlLifecycle = { controller };
      windowLifecycles.set(windowId, lifecycle);
      const signal = controller.signal;
      const assertActive = () => signal.throwIfAborted();
      try {
        await stopped;
        const readAuthContext = async () => {
          for (;;) {
            const revision = authNotificationRevision;
            const endpointUrls = await dependencies.getEndpointUrls?.();
            const login = await dependencies.getLogin();
            assertActive();
            // The account may also change while the first read has not yet bound an identity; an old read must not be bound after a new login.
            if (revision === authNotificationRevision) return { endpointUrls, login };
          }
        };
        const { endpointUrls, login } = await readAuthContext();
        const relayWsUrl = endpointUrls?.relayWsUrl ?? dependencies.relayWsUrl;
        const mobileRemoteControlUrl =
          endpointUrls?.remoteUrl ?? dependencies.mobileRemoteControlUrl;
        const endpointOrigin = new URL(endpointUrls?.origin ?? mobileRemoteControlUrl).origin;
        assertActive();
        if (!login?.jwt || !login.userId) {
          requireAuthentication(windowId);
          throw new WebRemoteControlV2ConnectionError("auth-required");
        }
        lifecycle.identity = { userId: login.userId, endpointOrigin };
        authRequiredWindows.delete(windowId);
        // Pre-V2 pairing data cannot be reused by the V2 relay; discard it and tell the user to re-pair.
        const repairRequired = await dependencies.deviceStorage.clearLegacy();
        if (repairRequired) {
          dependencies.logger.info(
            "[web-remote-control] discarded pre-V2 pairing; re-pair required",
          );
        }
        assertActive();
        // Relay HTTP shares the origin of the relay WS URL (self-hosted relays are configured as one origin).
        const relayOrigin = relayHttpOriginFromWsUrl(relayWsUrl);
        const http = createWebRemoteControlV2Http(relayOrigin);
        const currentLogin = async (): Promise<WebRemoteControlLogin> => {
          const current = await dependencies.getLogin();
          const endpoint = await dependencies.getEndpointUrls?.();
          assertActive();
          if (
            !current?.jwt ||
            current.userId !== login.userId ||
            (endpoint && endpoint.origin !== endpointOrigin)
          ) {
            throw new WebRemoteControlV2ConnectionError("auth-required");
          }
          if (!dependencies.relayBearer) return current;
          const jwt = await dependencies.relayBearer.getJwt({
            relayOrigin: relayHttpOriginFromWsUrl(relayWsUrl),
            identityJwt: current.jwt,
            signal,
          });
          assertActive();
          return { userId: current.userId, jwt };
        };
        const register = (force: boolean, transportSignal: AbortSignal) => {
          const registrationSignal = AbortSignal.any([signal, transportSignal]);
          // The manager reads/updates identity serially so that first starts in multiple windows do not each overwrite the persisted SID.
          const operation = registrationQueue.then(async () => {
            const current = await currentLogin();
            const stored = await dependencies.deviceStorage.load();
            registrationSignal.throwIfAborted();
            if (
              !force &&
              !forceRegistration &&
              stored?.userId === current.userId &&
              stored.endpointOrigin === endpointOrigin
            )
              return stored.deviceSid;
            if (stored?.endpointOrigin === endpointOrigin) {
              try {
                await http.delete(stored.deviceSid, current.jwt, registrationSignal);
              } catch {
                dependencies.logger.warn("[web-remote-control] V2 old device cleanup failed");
              }
            }
            registrationSignal.throwIfAborted();
            const deviceSid = await http.register(
              dependencies.deviceMid,
              current.jwt,
              registrationSignal,
            );
            await currentLogin();
            registrationSignal.throwIfAborted();
            try {
              await dependencies.deviceStorage.save({
                deviceSid,
                userId: current.userId,
                endpointOrigin,
              });
            } catch (error) {
              // A save failure is not a network failure; a bare error would make the transport register a new SID on every backoff and leave orphan devices.
              // The new SID has not connected yet, so first make a best-effort attempt to revoke the remote registration, then end this start with a non-retryable error.
              dependencies.logger.error(
                "[web-remote-control] V2 device identity persistence failed",
                error,
              );
              try {
                await http.delete(deviceSid, current.jwt, registrationSignal);
              } catch {
                dependencies.logger.warn("[web-remote-control] V2 new device cleanup failed");
              }
              throw new WebRemoteControlV2ConnectionError("relay-unavailable");
            }
            registrationSignal.throwIfAborted();
            dependencies.logger.info("[web-remote-control] V2 device registered");
            return deviceSid;
          });
          registrationQueue = operation.catch(() => {});
          return operation;
        };
        let deviceSid = "";
        let runtime: WindowControlRuntime;
        let readySettled = false;
        let persistEnabled: Promise<void> | undefined;
        const readyPromise = new Promise<void>((resolve, reject) => {
          const finish = (error?: Error) => {
            if (readySettled) return;
            readySettled = true;
            clearTimeout(timeout);
            signal.removeEventListener("abort", aborted);
            if (error) reject(error);
            else resolve();
          };
          const aborted = () => finish(new Error("Web remote control start cancelled"));
          signal.addEventListener("abort", aborted, { once: true });
          const timeout = setTimeout(
            () =>
              finish(
                new Error("External relay device did not reach QR-ready state before timeout."),
              ),
            EXTERNAL_RELAY_QR_READY_TIMEOUT_MS,
          );
          const transport = createTransport({
            relayWsUrl,
            deviceMid: dependencies.deviceMid,
            meta: {
              platform: process.platform,
              version: dependencies.appVersion,
              name: dependencies.deviceName,
            },
            getToken: async (transportSignal) => {
              const current = await currentLogin();
              const token = await http.token(
                current.jwt,
                AbortSignal.any([signal, transportSignal]),
              );
              await currentLogin();
              dependencies.logger.info("[web-remote-control] V2 device token acquired");
              return token;
            },
            resolveDeviceSid: async (transportSignal, forceRegistration) => {
              deviceSid = await register(forceRegistration, transportSignal);
              if (runtimes.get(windowId) === runtime) {
                runtime.deviceSid = deviceSid;
                runtime.qrUrl = runtime.connectUrl = "";
              }
              return deviceSid;
            },
            logger: dependencies.logger,
            onStateChange: (state) => {
              if (runtimes.get(windowId) !== runtime) return;
              if (state === "waiting_terminal" || state === "paired") {
                runtime.qrUrl = runtime.connectUrl = createQrUrl(deviceSid, mobileRemoteControlUrl);
              }
              mapTransportState(runtime, state);
              if (state === "waiting_terminal" || state === "paired") {
                // A timeout on the first call does not cancel background recovery; the enable intent must still be saved when it truly becomes ready for the first time.
                persistEnabled ??= dependencies.startupRestoreStorageProvider.save({
                  workspacePath: context.workspacePath,
                  workspaceIdentity: context.workspaceIdentity,
                  initialTaskId: context.initialTaskId,
                });
                void persistEnabled.then(
                  () => finish(),
                  (error: unknown) => {
                    finish(error instanceof Error ? error : new Error(String(error)));
                    if (runtimes.get(windowId) === runtime)
                      void stopWindowRuntime(windowId, "startup-restore-persist-failed");
                  },
                );
              }
              if (state === "kicked") finish(new Error("session-conflict"));
            },
            onPayload: (payload) => routePayload(runtime, payload),
            onRawTransportPayload: (payload) => routeRawTransportCandidate(runtime, payload),
            onRawTransportFault: (reasonCode) =>
              runtime.currentBridge?.relayProtocol?.markDegraded(reasonCode),
            onSendReady: (event) => {
              flushPendingOutboundPayloads(runtime);
              const isFirstSendReadyForPairing = !runtime.hasObservedSendReadyForPairing;
              runtime.hasObservedSendReadyForPairing = true;
              if (event.kind === "reconnected-socket" || isFirstSendReadyForPairing) {
                // Bug cause: same-socket heartbeat ACKs fire send-ready about every 10 seconds; if a degraded latch is re-sent every time,
                // the Web side would repeatedly rebuild the same recovery generation and break the bounded 1s/2s/5s backoff.
                sendPendingBridgeInvalidation(runtime);
                requestMobileTaskView(runtime);
              }
              const relayProtocol = runtime.currentBridge?.relayProtocol;
              // Un-ACKed batches of the same bridge remain owned exclusively by the adapter; replay after reconnect without refreshing queued age.
              if (relayProtocol && !relayProtocol.isDegraded())
                relayProtocol.replayUnacknowledged();
            },
            onError: (error) => {
              if (runtimes.get(windowId) !== runtime) return;
              const failure = createFailure(
                error instanceof WebRemoteControlV2ConnectionError
                  ? error.reason
                  : "relay-unavailable",
                error.message,
              );
              finish(error);
              if (failure.reason === "auth-required") requireAuthentication(windowId);
              else preserveWindowRuntimeFailure(windowId, runtime, "v2-auth-failed", failure);
            },
          });
          runtime = {
            windowId,
            workspacePath: context.workspacePath,
            workspaceIdentity: context.workspaceIdentity,
            remoteSessionId: context.remoteSessionId,
            initialTaskId: context.initialTaskId,
            theme: context.theme,
            status: "starting",
            deviceSid,
            deviceMid: dependencies.deviceMid,
            connectUrl: "",
            qrUrl: "",
            transport,
            mobileConnected: false,
            hasEverPaired: false,
            hasObservedSendReadyForPairing: false,
            pendingOutboundPayloads: [],
            repairRequired,
          };
          runtimes.set(windowId, runtime);
          emitRuntimeStatus(runtime);
          transport.start();
        });
        await readyPromise;
        assertActive();
        return {
          status: runtime!.status === "active" ? "active" : "running",
          sessionId: deviceSid,
          windowControlSessionId: deviceSid,
          qrUrl: runtime!.qrUrl,
          connectUrl: runtime!.connectUrl,
          workspacePath: context.workspacePath,
          workspaceIdentity: context.workspaceIdentity,
          remoteSessionId: context.remoteSessionId,
          initialTaskId: context.initialTaskId,
        };
      } catch (error) {
        if (
          !signal.aborted &&
          error instanceof WebRemoteControlV2ConnectionError &&
          error.reason === "auth-required"
        ) {
          requireAuthentication(windowId);
        }
        throw error;
      }
    },

    // Refresh the QR code: the old SID may have leaked, so the current runtime is closed and the
    // device is registered again (the old device record is deleted before the new one is saved).
    async resetPairing(
      windowId: number,
      context: WebRemoteControlContext,
    ): Promise<WebRemoteControlStartResult> {
      dependencies.featureGate.assertEnabled();
      await stopWindowRuntime(windowId, "leaked-qr");
      return this.start(windowId, context, { forceRegistration: true });
    },

    async resetPairingAuthorized(
      windowId: number,
      context: WebRemoteControlContext,
      authorization: WebRemoteControlStartAuthorization,
    ): Promise<WebRemoteControlStartResult> {
      consumeStartAuthorization(windowId, context, authorization);
      return this.resetPairing(windowId, context);
    },

    async stop(windowId: number): Promise<void> {
      lifecycleRevision += 1;
      authNotificationRevision += 1;
      startupRestoreClaimed = true;
      authRequiredWindows.delete(windowId);
      clearStartAuthorizationsForWindow(windowId);
      // Bugfix: clearing the auto-restore setting requires a disk write; a failure must not prevent the user from closing the current remote-control connection.
      // Release the transport and attachment first, then return the persistence error to the UI, so this run stops immediately.
      await stopWindowRuntime(windowId, "manual-stop");
      await dependencies.startupRestoreStorageProvider.clear();
    },

    async suspend(windowId: number, reason: string): Promise<void> {
      clearStartAuthorizationsForWindow(windowId);
      await stopWindowRuntime(windowId, reason);
    },

    async notifyAuthStateChanged(
      windowId: number,
      change: WebRemoteControlAuthStateChange,
    ): Promise<void> {
      const revision = ++authNotificationRevision;
      if (change.state === "signed-in") {
        const login = await dependencies.getLogin();
        const endpointUrls = await dependencies.getEndpointUrls?.();
        if (revision !== authNotificationRevision) return;
        if (!login?.jwt || !login.userId) {
          requireAuthentication(windowId);
          return;
        }
        const endpointOrigin = new URL(endpointUrls?.origin ?? dependencies.mobileRemoteControlUrl)
          .origin;
        const staleWindows = [...windowLifecycles].filter(
          ([, lifecycle]) =>
            lifecycle.identity &&
            (lifecycle.identity.userId !== login.userId ||
              lifecycle.identity.endpointOrigin !== endpointOrigin),
        );
        if (staleWindows.length > 0) {
          lifecycleRevision += 1;
          startupRestoreClaimed = false;
          // Synchronously revoke all old generations before waiting; an authenticated socket does not re-verify the JWT, so do not just wait for the next token fetch.
          await Promise.all(
            staleWindows.map(([id]) => {
              clearStartAuthorizationsForWindow(id);
              return stopWindowRuntime(id, "auth-identity-changed");
            }),
          );
          if (revision !== authNotificationRevision) return;
        }
        for (const id of authRequiredWindows)
          dependencies.onStatusChanged?.(id, { status: "idle" });
        authRequiredWindows.clear();
        for (const [candidateWindowId, contexts] of availableWorkspacesByWindowId) {
          if (await this.restorePreviouslyEnabled(candidateWindowId, contexts)) break;
          if (revision !== authNotificationRevision) return;
        }
        return;
      }
      lifecycleRevision += 1;
      startupRestoreClaimed = false;
      const windowIds = new Set([
        windowId,
        ...availableWorkspacesByWindowId.keys(),
        ...runtimes.keys(),
        ...windowLifecycles.keys(),
      ]);
      // Synchronously revoke the start/connection of all windows before waiting on the caller; logout must not be resurrected by a slow HTTP write-back.
      for (const id of windowIds) {
        clearStartAuthorizationsForWindow(id);
        requireAuthentication(id);
      }
    },

    async restorePreviouslyEnabled(
      windowId: number,
      candidates: Array<WebRemoteControlContext & { label?: string }>,
    ): Promise<boolean> {
      // Fix cause: candidate snapshots and syncAvailableWorkspaces share the same WorkspaceTarget table, and label is a required display field;
      // production callers pass the complete target, and only calls carrying just a context fall back to the path; never write a list entry missing a label.
      availableWorkspacesByWindowId.set(
        windowId,
        candidates.map((candidate) => ({
          ...candidate,
          label: candidate.label ?? candidate.workspacePath,
          kind: candidate.workspaceIdentity || candidate.remoteSessionId ? "remote" : "local",
        })),
      );
      // After a 401/logout only a login notification can lift the gate; workspace sync must not retry an invalid JWT.
      if (startupRestoreClaimed || runtimes.has(windowId) || authRequiredWindows.has(windowId))
        return false;
      const revision = lifecycleRevision;
      const persistedContext = await dependencies.startupRestoreStorageProvider
        .load()
        .catch((error) => {
          dependencies.logger.warn(
            "[web-remote-control] load startup restore context failed",
            error,
          );
          return undefined;
        });
      if (revision !== lifecycleRevision || startupRestoreClaimed || !persistedContext) {
        return false;
      }

      const persistedWorkspaceKey = resolveWebRemoteControlWorkspaceKey(persistedContext);
      // Tab closes or remote reconnects may happen during a disk read; only consume the latest complete snapshot.
      const currentContext = availableWorkspacesByWindowId
        .get(windowId)
        ?.find(
          (candidate) => resolveWebRemoteControlWorkspaceKey(candidate) === persistedWorkspaceKey,
        );
      if (
        !currentContext ||
        (currentContext.kind === "remote" && !currentContext.remoteSessionId)
      ) {
        return false;
      }

      startupRestoreClaimed = true;
      dependencies.logger.info(
        `[web-remote-control] restoring previous enabled state window=${windowId} workspace=${currentContext.workspacePath} remoteSession=${currentContext.remoteSessionId ?? "none"}`,
      );
      try {
        await this.start(windowId, {
          workspacePath: currentContext.workspacePath,
          workspaceIdentity: currentContext.workspaceIdentity,
          remoteSessionId: currentContext.remoteSessionId,
          initialTaskId: persistedContext.initialTaskId,
        });
        return true;
      } catch (error) {
        if (revision === lifecycleRevision) startupRestoreClaimed = false;
        dependencies.logger.warn(
          "[web-remote-control] restore previous enabled state failed",
          error,
        );
        return false;
      }
    },

    getStatus(windowId: number): WebRemoteControlStatus {
      if (!dependencies.featureGate.isEnabled()) {
        return {
          status: "idle",
          failure: createFailure(
            "unsupported-action",
            "Web remote control is disabled in this build.",
          ),
        };
      }

      if (authRequiredWindows.has(windowId)) return { status: "auth-required" };
      const runtime = runtimes.get(windowId);
      if (!runtime) {
        return { status: "idle" };
      }

      return buildRuntimeStatus(runtime);
    },

    syncAvailableWorkspaces(windowId: number, workspaces: WebRemoteControlWorkspaceTarget[]): void {
      availableWorkspacesByWindowId.set(windowId, workspaces);
      const runtime = runtimes.get(windowId);
      if (!runtime) {
        return;
      }
      pushWorkspaceListUpdated(runtime);
    },

    async replaceRemoteSession(event: {
      previousSessionId: string;
      sessionId: string;
      workspacePath: string;
      workspaceIdentity: string;
    }): Promise<void> {
      for (const [windowId, runtime] of runtimes) {
        const bridge = runtime.currentBridge;
        const bridgeMatches =
          bridge?.remoteSessionId === event.previousSessionId &&
          bridge.workspacePath === event.workspacePath &&
          bridge.workspaceIdentity === event.workspaceIdentity;
        const runtimeMatches = runtime.remoteSessionId === event.previousSessionId;
        const availableWorkspaces = availableWorkspacesByWindowId.get(windowId);
        if (availableWorkspaces) {
          availableWorkspacesByWindowId.set(
            windowId,
            availableWorkspaces.map((workspace) =>
              workspace.remoteSessionId === event.previousSessionId &&
              workspace.workspacePath === event.workspacePath &&
              workspace.workspaceIdentity === event.workspaceIdentity
                ? { ...workspace, remoteSessionId: event.sessionId, connectionState: "connected" }
                : workspace,
            ),
          );
        }
        if (runtimeMatches) runtime.remoteSessionId = event.sessionId;
        if (!bridgeMatches || !bridge) {
          if (runtimeMatches || availableWorkspaces) pushWorkspaceListUpdated(runtime);
          continue;
        }

        // Bug cause: Main previously reused the same bridge identity to rebuild the acknowledged protocol,
        // the new protocol's seq starts at 1, yet the phone's assembler still waits for N+1, so new frames were treated as old duplicates
        // and silently dropped. Only a non-terminal degraded is sent here; the Web's existing recovery flow rebuilds actively with a new identity.
        bridge.degraded = true;
        runtime.pendingBridgeInvalidation = {
          zcode_type: "bridge-degraded",
          bridgeSessionId: bridge.bridgeSessionId,
          ...(bridge.bridgeGeneration === undefined
            ? {}
            : { bridgeGeneration: bridge.bridgeGeneration }),
          ...(bridge.recoveryId ? { recoveryId: bridge.recoveryId } : {}),
          reason: "source-session-replaced",
        };
        disposeRuntimeBridgeResources(runtime);
        sendPendingBridgeInvalidation(runtime);
        pushWorkspaceListUpdated(runtime);
      }
    },

    // Bot /remote reuse path: return the current connect URL from a live runtime that can already
    // serve the requested workspace, without restarting it (a restart would drop an active phone
    // pairing). Returns null when no live runtime covers the workspace. The V2 QR carries routing
    // hints only, so no credential is read or minted here.
    async findLinkForWorkspace(target: {
      workspacePath: string;
      workspaceIdentity?: string;
    }): Promise<{ url: string; sessionId: string } | null> {
      if (!dependencies.featureGate.isEnabled()) {
        return null;
      }
      const workspaceKey = resolveWebRemoteControlWorkspaceKey(target);
      for (const runtime of runtimes.values()) {
        if (runtime.status === "error") {
          continue;
        }
        // Only bridgeable targets count as "serving": the synced list deliberately keeps
        // disconnected remote tabs for display, and failRemoteSession can clear a runtime's
        // remoteSessionId while leaving the runtime alive. Reusing either would hand the Bot a
        // URL whose workspace bridge open is rejected; those cases must fall through to the
        // reconnect-and-start path instead.
        const servesWorkspace = getAvailableWorkspaces(runtime).some(
          (workspace) =>
            resolveWebRemoteControlWorkspaceKey(workspace) === workspaceKey &&
            isBridgeableRemoteTarget(workspace),
        );
        // qrUrl is set only once the device reached waiting_terminal or paired, so an empty value
        // means the runtime has no usable connect URL yet.
        if (!servesWorkspace || !runtime.deviceSid || !runtime.qrUrl) {
          continue;
        }
        const endpointUrls = await dependencies.getEndpointUrls?.();
        const baseUrl = endpointUrls?.remoteUrl ?? dependencies.mobileRemoteControlUrl;
        return {
          url: createQrUrl(runtime.deviceSid, baseUrl),
          sessionId: runtime.deviceSid,
        };
      }
      return null;
    },

    async disposeWindow(windowId: number): Promise<void> {
      lifecycleRevision += 1;
      authRequiredWindows.delete(windowId);
      clearStartAuthorizationsForWindow(windowId);
      await stopWindowRuntime(windowId, "window-disposed");
      availableWorkspacesByWindowId.delete(windowId);
      pushedWorkspaceListSignaturesByWindowId.delete(windowId);
    },

    failRemoteSession(
      remoteSessionId: string,
      reason: string,
      failure: WebRemoteControlFailure,
    ): void {
      for (const [windowId, runtime] of runtimes) {
        const bridge = runtime.currentBridge;
        const bridgeUsesRemoteSession = bridge?.remoteSessionId === remoteSessionId;
        const runtimeUsesRemoteSession = runtime.remoteSessionId === remoteSessionId;

        if (!bridgeUsesRemoteSession && !runtimeUsesRemoteSession) {
          continue;
        }

        // Bugfix: a remote workspace session is only a dependency of some workspace/bridge; its disconnect must not be escalated into
        // a window-level Web remote control device WS failure; otherwise a single remote idle exit would wrongly close the desktop's global remote-control entry point.
        if (bridgeUsesRemoteSession) {
          disposeRuntimeBridgeResources(runtime);
          sendAppPayload(runtime, {
            zcode_type: "workspace-bridge-error",
            bridgeSessionId: bridge.bridgeSessionId,
            ...(bridge.bridgeGeneration !== undefined
              ? { bridgeGeneration: bridge.bridgeGeneration }
              : {}),
            ...(bridge.recoveryId ? { recoveryId: bridge.recoveryId } : {}),
            requestId: `remote-session-closed:${remoteSessionId}`,
            reason: failure.reason,
            error: failure.message ?? failure.reason,
          });
        }
        if (runtimeUsesRemoteSession) {
          runtime.remoteSessionId = undefined;
        }
        // Workspace lifecycle must not revive a device connection terminated by 401 or KICKED.
        if (runtime.status !== "error") {
          runtime.status = runtime.mobileConnected ? "active" : "running";
          runtime.error = undefined;
          runtime.failure = undefined;
        }
        runtimes.set(windowId, runtime);
        emitRuntimeStatus(runtime);
      }
      dependencies.disposeWorkspaceHostAttachmentsForRemoteSession(remoteSessionId, reason);
    },
  };
}

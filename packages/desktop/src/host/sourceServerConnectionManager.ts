import {
  sourceServerRunningTasksSchema,
  type SourceServerRunningTask,
  type SourceServerRunningTasksResult,
} from "@zcode/shared";
/* eslint-disable max-lines -- The Source connection state machine, retries, updates, and single-connection merging must share one generation state. */
import { SourceServerOperationLogs } from "./sourceServerOperationLogs.js";
import { Emitter, type Event } from "@zcode/rpc";
import type {
  ConnectionProfile,
  RemoteTarget,
  ServerRemoteInfo,
  CompatibilityManifest,
  SourceServerArtifactPolicy,
  SourceServerConnectionStateSnapshot,
} from "@zcode/shared";
import {
  SOURCE_SERVER_INSTALL_REQUIRED_ERROR_CODE,
  SOURCE_SERVER_IDENTITY_CHANGE_PENDING_ERROR_CODE,
  SOURCE_SERVER_UPGRADE_REQUIRED_ERROR_CODE,
  REMOTE_RECOVERY_BUDGET_EXHAUSTED_ERROR_CODE,
  ZCODE_COMPATIBILITY_MANIFEST,
  compareCompatibilityVersions,
  evaluateSourceServerCompatibility,
  isPublicZCodeErrorCode,
  normalizeRemoteConnectionError,
  stripRemoteTargetSecrets,
} from "@zcode/shared";
import type { IServiceAccessor } from "@zcode/services";
import {
  appendTrustedHostKey,
  defaultKnownHostsFiles,
  type KnownHostsFiles,
  type SSHHostKeyFailure,
} from "@zcode/server/remote";
import {
  createSourceServerTransportAdapter,
  readServerCommandResult,
  type ServerReleaseAsset,
  type SourceServerFileTransfer,
  type SourceServerIngressInfo,
  type SourceServerTransportAdapter,
  type TransportContext,
} from "@zcode/server/source-server";
import {
  connectServerRemoteOverDuplex,
  type ServerRemoteConnection,
  type ServerRemoteDuplexConnectionOptions,
} from "./serverRemoteConnection.js";
import type { SourceServerDirectory } from "./sourceServerDirectory.js";
import { isSourceServerAutomaticRecoveryTerminalState } from "./sourceServerRecoveryPolicy.js";

export type {
  SourceServerConnectionState,
  SourceServerConnectionStateSnapshot,
} from "@zcode/shared";

export interface ManagedSourceServerConnection {
  /** The actual redacted target used when this call reuses a physical connection; not written to the online owner. */
  reusedConnectionTarget?: RemoteTarget;
  sourceServerId: string;
  profileId: string;
  serverInfo: ServerRemoteInfo;
  services: IServiceAccessor;
}

/** Device-level lifecycle operations that make the remote side drop the connection on purpose. */
type LifecycleOperationKind = "update" | "stop" | "restart";

/**
 * Lifecycle operations that turn the closing of a same-Source online connection into an "expected disconnect": update and restart, after which reconnect bumps the generation.
 * Stop deletes the recovery intent and releases the connection before running the remote command, so it is not in this category.
 */
type ExpectedDisconnectOperationKind = Exclude<LifecycleOperationKind, "stop">;

export type SourceServerConnectionInvalidatedEvent =
  | {
      sourceServerId: string;
      /** An update or restart of the remote service invalidates the online connection; both are recoverable, and reconnect bumps the generation afterwards. */
      reason: ExpectedDisconnectOperationKind;
    }
  | {
      sourceServerId: string;
      reason: "profile-removed";
      recoverable: false;
    };

export class SourceServerInstallRequiredError extends Error {
  public readonly code = SOURCE_SERVER_INSTALL_REQUIRED_ERROR_CODE;
  public readonly retryable = false;
  public constructor(public readonly profileId: string) {
    super("Source Server installation requires explicit user confirmation");
    this.name = "SourceServerInstallRequiredError";
  }
}

export class SourceServerUpgradeRequiredError extends Error {
  public readonly code = SOURCE_SERVER_UPGRADE_REQUIRED_ERROR_CODE;
  public readonly retryable = false;
  public constructor(
    public readonly profileId: string,
    public readonly upgradeTarget: "controller" | "server",
    public readonly currentVersion: string,
    public readonly minimumVersion: string,
    public readonly reason: "compatibility" | "development-archive" = "compatibility",
  ) {
    super(
      reason === "development-archive"
        ? `Source Server ${currentVersion} release archive differs from the current development build and must be updated`
        : upgradeTarget === "server"
          ? `Source Server ${currentVersion} must be upgraded to at least ${minimumVersion}`
          : `ZCode Desktop ${currentVersion} must be upgraded to at least ${minimumVersion}`,
    );
    this.name = "SourceServerUpgradeRequiredError";
  }
}

export class SourceServerIdentityChangePendingError extends Error {
  public readonly code = SOURCE_SERVER_IDENTITY_CHANGE_PENDING_ERROR_CODE;
  public readonly retryable = false;
  public constructor(
    public readonly profileId: string,
    public readonly pendingSourceServerId: string,
  ) {
    super("Source Server identity changed after reinstall and requires confirmation");
    this.name = "SourceServerIdentityChangePendingError";
  }
}

class SourceServerExplicitDisconnectError extends Error {
  public readonly code = "remote-connection-canceled";
  public constructor(public readonly sourceServerId: string) {
    super(`Source Server explicitly disconnected: ${sourceServerId}`);
    this.name = "SourceServerExplicitDisconnectError";
  }
}

class SourceServerProfileRemovedError extends Error {
  public constructor(public readonly profileId: string) {
    super(`Connection Profile removed: ${profileId}`);
    this.name = "SourceServerProfileRemovedError";
  }
}

/** A stop, restart, or update is already in progress on this device (R3 §8.4.5 mutual-exclusion matrix); not a public error code, the UI shows it with management error copy. */
class SourceServerLifecycleOperationInProgressError extends Error {
  public readonly code = "source-server-operation-in-progress";
  public readonly retryable = true;
  public constructor(public readonly sourceServerId: string) {
    super(`Another lifecycle operation is in progress for Source Server: ${sourceServerId}`);
    this.name = "SourceServerLifecycleOperationInProgressError";
  }
}

class SourceServerHandshakeClosedError extends Error {
  public readonly retryable = true;
  public constructor(reason: string) {
    super(`Source Server connection closed during handshake: ${reason}`);
    this.name = "SourceServerHandshakeClosedError";
  }
}

export interface SourceServerConnectionManagerOptions {
  /** Membership is owned by the persistence port; the connection manager only handles the ordering of admission and handshake commit. */
  admitConnection?: (input: {
    profile: ConnectionProfile;
    intent: "add" | "retain";
    confirmIdentityChange: boolean;
  }) => Promise<(sourceServerId: string) => Promise<void>>;
  directory: {
    recordLastOnline?(sourceServerId: string, timestamp: number): Promise<void>;
    markSourceUninstalled?(profileId: string): Promise<void>;
    recordHandshake(
      profileId: string,
      handshake: Parameters<SourceServerDirectory["recordHandshake"]>[1],
      options?: Parameters<SourceServerDirectory["recordHandshake"]>[2],
    ): Promise<{
      identityChanged: boolean;
      effectiveProfile?: ConnectionProfile;
    }>;
  };
  createAdapter?: (kind: "ssh" | "wsl" | "docker") => SourceServerTransportAdapter;
  connectServer?: (options: ServerRemoteDuplexConnectionOptions) => Promise<ServerRemoteConnection>;
  now?: () => number;
  logWarn?: (message: string, error: Error) => void;
  onProjectChange?: (sourceServerId: string) => void;
  compatibilityManifest?: CompatibilityManifest;
  sourceServerArtifactPolicy?: SourceServerArtifactPolicy;
  resolveRelease?: (
    probe: Awaited<ReturnType<SourceServerTransportAdapter["probe"]>>,
    target: Exclude<RemoteTarget, { kind: "server" }>,
    options?: { metadataOnly?: boolean },
  ) => Promise<ServerReleaseAsset>;
  /** known_hosts files the trust step appends to; tests inject a temp dir. */
  knownHostsFiles?: KnownHostsFiles;
}

export interface ConnectSourceServerOptions {
  membershipIntent?: "add" | "retain";
  profile: ConnectionProfile;
  target: RemoteTarget;
  release?: ServerReleaseAsset;
  allowInstall?: boolean;
  confirmIdentityChange?: boolean;
  resolveRelease?: SourceServerConnectionManagerOptions["resolveRelease"];
  context?: TransportContext;
  onDiagnosticPhase?: (phase: string) => void;
  /** Only called at the upgrade wait point by a flight that actually performs the probe/handshake; join requests must not commit a second credential. */
  onAuthenticatedUpgradeRequired?: () => Promise<void>;
}

export interface StartupReconnectResult {
  profileId: string;
  status: "online" | "failed";
  error?: string;
}

interface OnlineConnection extends ManagedSourceServerConnection {
  connection: ServerRemoteConnection;
  profileIds: Set<string>;
  projectSubscription?: { dispose(): void };
}

interface ReconnectInput {
  profile: ConnectionProfile;
  target: Exclude<RemoteTarget, { kind: "server" }>;
  context: TransportContext;
}

interface ConnectFlight {
  promise: Promise<ManagedSourceServerConnection>;
  sourceServerId?: string;
  controller: AbortController;
}

/**
 * Lifecycle operation flight: while an update or restart exists, closing of a same-Source online connection counts as an expected disconnect; it only invalidates the connection,
 * and does not schedule retries. Explicit disconnect, profile removal, and dispose abort it. Only multiple update flights may coexist for one Source
 * (initiated through sibling Profiles); stop and restart are mutually exclusive with every operation (R3 §8.4.5).
 */
interface LifecycleOperationFlight {
  kind: LifecycleOperationKind;
  profileId: string;
  sourceServerId?: string;
  controller: AbortController;
}

/** Connection and credentials used by device-level operations (stop, restart, reading running tasks) to run remote commands. */
type SourceOperationRoute = Pick<ReconnectInput, "profile" | "target">;

const ONLINE_RETRY_DELAYS_MS = [2_000, 4_000, 8_000] as const;
const OFFLINE_PROBE_INTERVAL_MS = 2 * 60_000;

/**
 * Error fields written to connection state when a lifecycle operation (update, stop, restart) fails. errorCode and retryable come from the same normalized
 * result (single source): when the error code comes from an inner cause, retryable must not be read from the outer wrapper. When the remote does not declare retryable,
 * it is treated as retryable (confirmed 2026-10-21, including stop failures).
 */
function describeLifecycleOperationFailure(
  error: unknown,
): Pick<SourceServerConnectionStateSnapshot, "error" | "errorCode" | "retryable"> {
  const normalized = normalizeRemoteConnectionError(error);
  return {
    error: normalized.message,
    ...(isPublicZCodeErrorCode(normalized.code) ? { errorCode: normalized.code } : {}),
    retryable: normalized.retryable ?? true,
  };
}

/** Status projection on a connection invalidated by an expected-disconnect operation: restart only shows "connecting" and must not show as updating (RDLC-01). */
function expectedDisconnectProjection(
  kind: ExpectedDisconnectOperationKind,
): "updating" | "bootstrapping" {
  return kind === "restart" ? "bootstrapping" : "updating";
}

function readErrorRetryable(error: unknown): boolean | undefined {
  if (!error || typeof error !== "object" || !("retryable" in error)) {
    return undefined;
  }
  return typeof error.retryable === "boolean" ? error.retryable : undefined;
}

function findHostKeyError(error: unknown): (Error & { hostKey: SSHHostKeyFailure }) | undefined {
  // Transport and registry layers may wrap the backend error; follow the cause chain to the stamped original.
  for (let current = error, depth = 0; current && depth < 5; depth += 1) {
    if (typeof current !== "object") return undefined;
    if ("hostKey" in current) return current as Error & { hostKey: SSHHostKeyFailure };
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

function readUnknownHostKey(error: unknown): SSHHostKeyFailure | undefined {
  const hostKey = findHostKeyError(error)?.hostKey;
  return hostKey?.kind === "unknown" ? hostKey : undefined;
}

/** Profile whose connect attempt refused an unknown host key; the trust step is keyed by it. */
export function readHostKeyProfileId(error: unknown): string | undefined {
  const stamped = findHostKeyError(error);
  if (stamped?.hostKey.kind !== "unknown") return undefined;
  const profileId = (stamped as { profileId?: unknown }).profileId;
  return typeof profileId === "string" ? profileId : undefined;
}

function hostKeyTrustUnavailableError(): Error {
  // The observed key lives only in this Host's memory; after a restart or a newer attempt the user must connect again
  // and see the prompt for the key that is actually offered.
  return Object.assign(new Error("No host key is waiting for trust; connect again"), {
    code: "remote-host-key-unknown",
    retryable: false,
  });
}

function isAutomaticRecoveryUserActionCode(code: unknown): boolean {
  return (
    code === SOURCE_SERVER_INSTALL_REQUIRED_ERROR_CODE ||
    code === SOURCE_SERVER_UPGRADE_REQUIRED_ERROR_CODE ||
    code === SOURCE_SERVER_IDENTITY_CHANGE_PENDING_ERROR_CODE
  );
}

function buildCompatibilityState(
  controller: CompatibilityManifest,
  server: CompatibilityManifest,
): Pick<
  SourceServerConnectionStateSnapshot,
  "updateAvailability" | "currentVersion" | "availableVersion" | "minimumVersion" | "upgradeTarget"
> {
  const result = evaluateSourceServerCompatibility(controller, server);
  if (!result.compatible && result.upgradeTarget) {
    return {
      updateAvailability: "required",
      currentVersion: result.olderVersion,
      availableVersion: result.newerVersion,
      minimumVersion: result.requiredMinimumVersion,
      upgradeTarget: result.upgradeTarget,
    };
  }
  if (result.updateAvailable) {
    return {
      updateAvailability: "available",
      currentVersion: result.olderVersion,
      availableVersion: result.newerVersion,
      minimumVersion: result.requiredMinimumVersion,
      upgradeTarget: result.newerEndpoint === "controller" ? "server" : "controller",
    };
  }
  return {
    updateAvailability: "none",
    currentVersion: server.productVersion,
    availableVersion: server.productVersion,
    minimumVersion: result.requiredMinimumVersion,
  };
}

function preserveCompatibilityState(
  snapshot: SourceServerConnectionStateSnapshot,
): Pick<
  SourceServerConnectionStateSnapshot,
  | "updateAvailability"
  | "currentVersion"
  | "availableVersion"
  | "minimumVersion"
  | "upgradeTarget"
  | "downgradedFrom"
> {
  return {
    ...(snapshot.updateAvailability ? { updateAvailability: snapshot.updateAvailability } : {}),
    ...(snapshot.currentVersion ? { currentVersion: snapshot.currentVersion } : {}),
    ...(snapshot.availableVersion ? { availableVersion: snapshot.availableVersion } : {}),
    ...(snapshot.minimumVersion ? { minimumVersion: snapshot.minimumVersion } : {}),
    ...(snapshot.upgradeTarget ? { upgradeTarget: snapshot.upgradeTarget } : {}),
    ...(snapshot.downgradedFrom ? { downgradedFrom: snapshot.downgradedFrom } : {}),
  };
}

function createConcurrencyGate(limit: number): {
  acquire(): Promise<() => void>;
} {
  let active = 0;
  const waiting: Array<() => void> = [];
  return {
    acquire: async () =>
      await new Promise<() => void>((resolve) => {
        const grant = () => {
          active += 1;
          let released = false;
          resolve(() => {
            if (released) return;
            released = true;
            active -= 1;
            waiting.shift()?.();
          });
        };
        if (active < limit) grant();
        else waiting.push(grant);
      }),
  };
}

export class SourceServerConnectionManager {
  private readonly adapters = new Map<string, SourceServerTransportAdapter>();
  private readonly states = new Map<string, SourceServerConnectionStateSnapshot>();
  private readonly compatibilityByProfileId = new Map<
    string,
    ReturnType<typeof preserveCompatibilityState>
  >();
  private readonly onlineBySourceServerId = new Map<string, OnlineConnection>();
  private readonly connectFlights = new Map<string, ConnectFlight>();
  private readonly stateEmitter = new Emitter<SourceServerConnectionStateSnapshot>();
  private readonly reconnectEmitter = new Emitter<ManagedSourceServerConnection>();
  private readonly connectionInvalidatedEmitter =
    new Emitter<SourceServerConnectionInvalidatedEvent>();
  private readonly reconnectInputs = new Map<string, ReconnectInput>();
  private readonly profileIdsBySourceServerId = new Map<string, Set<string>>();
  private readonly retryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly offlineProbeTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly lifecycleOperationFlights = new Set<LifecycleOperationFlight>();
  public readonly onDidChangeState: Event<SourceServerConnectionStateSnapshot> =
    this.stateEmitter.event;
  public readonly onDidReconnect: Event<ManagedSourceServerConnection> =
    this.reconnectEmitter.event;
  public readonly onDidInvalidateConnection: Event<SourceServerConnectionInvalidatedEvent> =
    this.connectionInvalidatedEmitter.event;
  private readonly createAdapter: NonNullable<
    SourceServerConnectionManagerOptions["createAdapter"]
  >;
  private readonly connectServer: NonNullable<
    SourceServerConnectionManagerOptions["connectServer"]
  >;
  private readonly now: () => number;
  private readonly compatibilityManifest: CompatibilityManifest;

  // Unknown host keys refused by the last connect attempt of each profile, held until the user trusts or retries.
  private readonly pendingHostKeys = new Map<string, SSHHostKeyFailure>();
  private readonly operationLogs = new SourceServerOperationLogs(() => this.now());
  public readonly onDidAppendOperationLog = this.operationLogs.onDidAppend;
  public getRecentOperationLogs(profile: Pick<ConnectionProfile, "profileId" | "sourceServerId">) {
    return this.operationLogs.read(profile);
  }

  public constructor(private readonly options: SourceServerConnectionManagerOptions) {
    this.createAdapter =
      options.createAdapter ?? ((kind) => createSourceServerTransportAdapter(kind));
    this.connectServer = options.connectServer ?? connectServerRemoteOverDuplex;
    this.now = options.now ?? Date.now;
    this.compatibilityManifest = options.compatibilityManifest ?? ZCODE_COMPATIBILITY_MANIFEST;
  }

  /**
   * Persists the unknown host key the user accepted for this profile. Only the exact key the last attempt observed can
   * be trusted; the caller reconnects afterwards and the ordinary known_hosts check admits it.
   */
  public async trustHostKey(profileId: string, fingerprint: string): Promise<void> {
    const pending = this.pendingHostKeys.get(profileId);
    if (!pending || pending.fingerprint !== fingerprint) throw hostKeyTrustUnavailableError();
    // The write can wait for another window's lock; a removal, success or newer attempt meanwhile cancels it.
    await appendTrustedHostKey(
      this.options.knownHostsFiles ?? defaultKnownHostsFiles(),
      pending,
      () => {
        if (this.pendingHostKeys.get(profileId) !== pending) throw hostKeyTrustUnavailableError();
      },
    );
    if (this.pendingHostKeys.get(profileId) !== pending) return;
    this.pendingHostKeys.delete(profileId);
    const current = this.states.get(profileId);
    if (current?.hostKeyPreview) {
      const {
        profileId: _profileId,
        updatedAt: _updatedAt,
        hostKeyPreview: _preview,
        ...rest
      } = current;
      this.setState(profileId, rest);
    }
  }

  public async connect(
    options: ConnectSourceServerOptions,
  ): Promise<ManagedSourceServerConnection> {
    try {
      return await this.connectForSource(
        { ...options, membershipIntent: options.membershipIntent ?? "add" },
        options.profile.sourceServerId,
      );
    } finally {
      // When a connection fails, is rejected, or reuses an existing one, this target did not become the recovery intent and must not leave an idle session behind.
      this.releaseTargetTransport(options.target);
    }
  }

  private reusedConnection(
    connection: ManagedSourceServerConnection,
  ): ManagedSourceServerConnection {
    const target = this.reconnectInputs.get(connection.sourceServerId)?.target;
    return {
      sourceServerId: connection.sourceServerId,
      profileId: connection.profileId,
      serverInfo: connection.serverInfo,
      services: connection.services,
      ...(target ? { reusedConnectionTarget: stripRemoteTargetSecrets(target) } : {}),
    };
  }

  private async connectForSource(
    options: ConnectSourceServerOptions,
    sourceServerId: string | undefined,
    recordOperation = true,
  ): Promise<ManagedSourceServerConnection> {
    const existingFlight = this.connectFlights.get(options.profile.profileId);
    if (existingFlight) return this.reusedConnection(await existingFlight.promise);
    const controller = new AbortController();
    const flightOptions = sourceServerId
      ? {
          ...options,
          context: {
            ...options.context,
            signal: options.context?.signal
              ? AbortSignal.any([options.context.signal, controller.signal])
              : controller.signal,
          },
        }
      : options;
    let flight!: ConnectFlight;
    const connect = (context: TransportContext) =>
      this.connectOnce({ ...flightOptions, context }, controller.signal);
    const promise = (
      recordOperation
        ? this.operationLogs.run(
            "connect",
            options.profile,
            options.target,
            flightOptions.context,
            connect,
          )
        : connect(flightOptions.context ?? {})
    ).finally(() => {
      if (this.connectFlights.get(options.profile.profileId) === flight) {
        this.connectFlights.delete(options.profile.profileId);
      }
    });
    flight = {
      promise,
      ...(sourceServerId ? { sourceServerId } : {}),
      controller,
    };
    this.connectFlights.set(options.profile.profileId, flight);
    return await promise;
  }

  public getStateByProfile(profileId: string): SourceServerConnectionStateSnapshot {
    return (
      this.states.get(profileId) ?? {
        profileId,
        state: "absent",
        updatedAt: this.now(),
      }
    );
  }

  public listStates(): SourceServerConnectionStateSnapshot[] {
    return [...this.states.values()];
  }

  public async reconnectOnStartup(
    candidates: Array<{
      profile: ConnectionProfile;
      target: Exclude<RemoteTarget, { kind: "server" }>;
    }>,
    options: { maxConcurrency?: number; timeoutMs?: number } = {},
  ): Promise<StartupReconnectResult[]> {
    if (candidates.length === 0) return [];
    const timeoutMs = options.timeoutMs ?? 10_000;
    const globalGate = createConcurrencyGate(Math.max(1, options.maxConcurrency ?? 3));
    // Bug cause: multiple Docker Sources share the local Docker daemon, disk, and CPU. When three cold-start probes
    // validating large release archives at the same time, a single manual connection needs only about 4.6 seconds, but three concurrent ones all hit the 10-second
    // limit together. Docker cold start is serialized inside the transport; SSH may still occupy the other global slots.
    const dockerGate = createConcurrencyGate(1);
    const reconnectCandidate = async (
      candidate: (typeof candidates)[number],
    ): Promise<StartupReconnectResult> => {
      const releaseTransport =
        candidate.target.kind === "docker" ? await dockerGate.acquire() : undefined;
      const releaseGlobal = await globalGate.acquire();
      const abortController = new AbortController();
      const startedAt = Date.now();
      let diagnosticPhase = "queued";
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          this.connect({
            profile: candidate.profile,
            target: candidate.target,
            membershipIntent: "retain",
            context: { signal: abortController.signal },
            onDiagnosticPhase: (phase) => {
              diagnosticPhase = phase;
            },
          }),
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => {
              reject(new Error(`Source Server startup reconnect timed out after ${timeoutMs}ms`));
              abortController.abort();
            }, timeoutMs);
          }),
        ]);
        return { profileId: candidate.profile.profileId, status: "online" };
      } catch (error) {
        if (error instanceof Error && error.message.includes("startup reconnect timed out")) {
          this.options.logWarn?.(
            `Source Server startup reconnect timeout diagnostic profile=${
              candidate.profile.profileId
            } transport=${candidate.target.kind} phase=${diagnosticPhase} elapsedMs=${Date.now() - startedAt}`,
            error,
          );
        }
        return {
          profileId: candidate.profile.profileId,
          status: "failed",
          error: error instanceof Error ? error.message : String(error),
        };
      } finally {
        if (timer) clearTimeout(timer);
        releaseGlobal();
        releaseTransport?.();
      }
    };
    // The most recently online Source corresponds to the workspace the user most likely still uses. The first candidate holds the startup window exclusively,
    // so it does not probe/handshake at the same time as the other Sources and exhaust the 10-second budget at the app's cold-start peak; the remaining
    // Sources then continue at the global concurrency of 3, without changing the single-Source timeout or the try-once contract.
    const [firstCandidate, ...remainingCandidates] = candidates;
    const firstResult = await reconnectCandidate(firstCandidate!);
    return [firstResult, ...(await Promise.all(remainingCandidates.map(reconnectCandidate)))];
  }

  public getOnlineConnection(sourceServerId: string): ManagedSourceServerConnection | undefined {
    return this.onlineBySourceServerId.get(sourceServerId);
  }

  public getFileTransfer(sourceServerId: string): SourceServerFileTransfer {
    const online = this.onlineBySourceServerId.get(sourceServerId);
    const input = this.reconnectInputs.get(sourceServerId);
    if (!online || !input) throw new Error("Source Server file transfer is unavailable");
    const backend = this.getAdapter(input.profile.transport).createFileTransfer(input.target);
    const assertCurrent = () => {
      // Staging belongs to the current attachment generation; old capabilities must not silently use a new route or rebuild a connection after a reconnect.
      if (this.onlineBySourceServerId.get(sourceServerId) !== online) {
        throw new Error("Source Server file transfer generation is unavailable");
      }
    };
    return {
      exec: async (command) => {
        assertCurrent();
        return backend.exec(command);
      },
      upload: async (localPath, remotePath, options) => {
        assertCurrent();
        await backend.upload(localPath, remotePath, options);
        assertCurrent();
      },
    };
  }

  public async updateServer(options: {
    profile: ConnectionProfile;
    target: Exclude<RemoteTarget, { kind: "server" }>;
    force?: boolean;
    allowDowngrade?: boolean;
    context?: TransportContext;
    release?: ServerReleaseAsset;
    resolveRelease?: SourceServerConnectionManagerOptions["resolveRelease"];
  }): Promise<ManagedSourceServerConnection> {
    const { profile } = options;
    // Must reject before writing the operation log: logs are owned per device and keep only the most recent operation, so a rejected update must not overwrite the stop log.
    if (profile.sourceServerId) {
      this.assertLifecycleOperationCanStart(profile.sourceServerId, "update");
    }
    // Bug cause: updates are not in connectFlights, so a late install result after a disconnect could still republish the connection.
    // Register by operation identity, so profiles that have not handshaken can also be canceled; cancellation removes the owner first, so an old update no longer blocks recovery of a new connection.
    const flight = this.registerLifecycleOperation(
      "update",
      profile.profileId,
      profile.sourceServerId,
    );
    const signal = options.context?.signal
      ? AbortSignal.any([options.context.signal, flight.controller.signal])
      : flight.controller.signal;
    try {
      return await this.operationLogs.run(
        "update",
        profile,
        options.target,
        { ...options.context, signal },
        (context) => this.updateServerOnce({ ...options, context }, flight.controller),
      );
    } finally {
      this.lifecycleOperationFlights.delete(flight);
      this.releaseTargetTransport(options.target);
    }
  }

  private async updateServerOnce(
    options: Parameters<SourceServerConnectionManager["updateServer"]>[0] & {
      context: TransportContext;
    },
    controller: AbortController,
  ): Promise<ManagedSourceServerConnection> {
    const { context } = options;
    const sourceServerId = options.profile.sourceServerId;
    const previousState = this.getStateByProfile(options.profile.profileId);
    const previousCompatibility = preserveCompatibilityState(previousState);
    if (sourceServerId) {
      this.clearRecoveryTimers(sourceServerId);
    }
    this.setState(options.profile.profileId, {
      state: "updating",
      ...(sourceServerId ? { sourceServerId } : {}),
      ...previousCompatibility,
    });
    let runningTasks: SourceServerRunningTask[] | undefined;
    try {
      context.signal?.throwIfAborted();
      const adapter = this.getAdapter(options.profile.transport);
      // Bug cause: the handshaken branch used to run the remote `zcode update` instead, but the normal install chain had no remote release
      // manifest URL configured, so production updates always failed. All profiles now have Desktop resolve the same archive and apply it through the Adapter.
      const probe = await adapter.probe(options.target, context);
      context.signal?.throwIfAborted();
      const releaseResolver = options.resolveRelease ?? this.options.resolveRelease;
      const release =
        options.release ?? (releaseResolver ? await releaseResolver(probe, options.target) : null);
      context.signal?.throwIfAborted();
      if (!release) throw new Error("Source Server update release is unavailable");
      await adapter.installOrUpdate(options.target, release, context, {
        force: options.force === true,
        ...(options.allowDowngrade ? { allowDowngrade: true } : {}),
      });
      context.signal?.throwIfAborted();
      const online = sourceServerId ? this.onlineBySourceServerId.get(sourceServerId) : undefined;
      if (sourceServerId && online) {
        this.invalidateOnlineConnectionForLifecycleOperation(sourceServerId, online, "update");
      }
      // An invalidation event's synchronous subscribers may also submit a disconnect, so this must not enter bootstrapping after that terminal state.
      context.signal?.throwIfAborted();
      // The reconnect event is fired uniformly at connectOnce's publish point; it is not published again here.
      return await this.connectForSource(
        {
          profile: options.profile,
          target: options.target,
          context,
        },
        sourceServerId,
        false,
      );
    } catch (error) {
      // Terminal states are published by disconnect/remove/release operations; the success or failure of an old update must not write back the captured old state.
      controller.signal.throwIfAborted();
      if (
        error &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "source-server-update-running-tasks"
      ) {
        // An unavailable task list must not bypass the force=false running-task guard; leaving it unknown is enough.
        runningTasks = await this.readRunningTasks(
          options.profile.transport,
          options.target,
          context,
        );
      }
      // Reading running-tasks also yields execution, so a disconnect may happen during error cleanup.
      controller.signal.throwIfAborted();
      this.settleFailedLifecycleOperation({
        kind: "update",
        profileId: options.profile.profileId,
        sourceServerId,
        previousState,
        runningTasks,
        error,
      });
      throw error;
    }
  }

  /**
   * Read-only `running-tasks --json` executed through the transport. The list uses a control command and does not extend the persisted status format;
   * if the remote outputs null (Core has not reported yet), the command fails, or the output does not match the schema, it returns undefined, meaning "task list unavailable".
   */
  private async readRunningTasks(
    transport: ConnectionProfile["transport"],
    target: Exclude<RemoteTarget, { kind: "server" }>,
    context: TransportContext,
  ): Promise<SourceServerRunningTask[] | undefined> {
    try {
      const result = await this.getAdapter(transport).exec(
        target,
        ["running-tasks", "--json"],
        context,
      );
      if (result.exitCode !== 0) return undefined;
      const parsed = sourceServerRunningTasksSchema.safeParse(JSON.parse(result.stdout.trim()));
      return parsed.success ? parsed.data : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Reads running tasks per device before the stop/restart confirmation (RDLC-01, R3 §8.4.5). Routing and credential rules are the same as for stop and restart:
   * when a recovery intent exists, its connection and in-memory credentials are reused; otherwise the caller resolves an offline route whose credentials can be obtained silently
   * (throws `credentials-required` if they cannot). Read-only: it does not register a lifecycle operation, change connection state, or write the device
   * operation log (logs keep only the most recent operation per device, and a read must not overwrite it).
   */
  public async getSourceRunningTasks(input: {
    sourceServerId: string;
    resolveOfflineRoute: () => Promise<SourceOperationRoute>;
  }): Promise<SourceServerRunningTasksResult> {
    const route = await this.resolveSourceOperationRoute(input);
    try {
      const tasks = await this.readRunningTasks(route.profile.transport, route.target, {});
      return tasks ? { available: true, tasks } : { available: false };
    } finally {
      this.releaseTargetTransport(route.target);
    }
  }

  /**
   * The single route resolution for device-level operations (stop, restart, reading running tasks): when the Source has a recovery intent (online, retrying, or offline probing),
   * its connection and in-memory credentials are reused; otherwise the caller resolves an offline route, by default the connection or most recent connection, whose credentials can be obtained silently.
   * Reading credentials yields execution, and a manual connection may publish a recovery intent during that time: the recovery intent's connection takes precedence, so the operation's Profile
   * is the connection that later takes over recovery. The mutual-exclusion recheck after yielding execution is the caller's responsibility.
   */
  private async resolveSourceOperationRoute(input: {
    sourceServerId: string;
    resolveOfflineRoute: () => Promise<SourceOperationRoute>;
  }): Promise<SourceOperationRoute> {
    const current = this.reconnectInputs.get(input.sourceServerId);
    if (current) return current;
    const offlineRoute = await input.resolveOfflineRoute();
    return this.reconnectInputs.get(input.sourceServerId) ?? offlineRoute;
  }

  /**
   * Unified handling of update and restart failures (R3 §8.4.5). When the physical connection is gone: if there is a non-terminal recovery intent, automatic recovery starts from the first tier;
   * without a recovery intent, an update stays offline with its error, and a restart shows connection failed (`failed`). If the connection is still up, the state from before the operation is restored.
   */
  private settleFailedLifecycleOperation(input: {
    kind: ExpectedDisconnectOperationKind;
    profileId: string;
    sourceServerId?: string;
    previousState: SourceServerConnectionStateSnapshot;
    runningTasks?: SourceServerRunningTask[];
    error: unknown;
  }): void {
    const { profileId, sourceServerId, previousState, runningTasks, error } = input;
    const failure = {
      ...preserveCompatibilityState(previousState),
      ...(runningTasks ? { runningTasks } : {}),
      ...describeLifecycleOperationFailure(error),
    };
    if (sourceServerId && !this.onlineBySourceServerId.has(sourceServerId)) {
      // If the transport disconnected during the operation, the captured online snapshot must not be restored, or a fake online with no connection and no timer would result.
      if (this.reconnectInputs.has(sourceServerId)) {
        if (!this.stopAutomaticRecoveryForTerminalFailure(sourceServerId, error)) {
          this.scheduleOnlineRetry(sourceServerId, 0);
        }
      } else {
        this.setState(profileId, {
          // Starting a restart from the never-connected state means "make the device available again", so failure must show connection failed rather than the neutral not-connected state.
          state: input.kind === "restart" ? "failed" : "offline",
          sourceServerId,
          ...failure,
        });
      }
      return;
    }
    this.setState(profileId, {
      // A failure is not a new compatibility fact; if the real connection is still up, restore the state from before the operation.
      state: previousState.state === "absent" ? "failed" : previousState.state,
      ...(sourceServerId ? { sourceServerId } : {}),
      ...failure,
    });
  }

  /**
   * Restarts the remote service on the device (RDLC-01, R3 §8.4.5). Registers a `restart` lifecycle operation flight and clears recovery timers;
   * the device shows "connecting"; runs `restart --json` through the transport; closing of the online connection caused by the old remote process exiting counts as an expected disconnect.
   * After the remote confirms the new daemon is ready, the existing connection flow runs and emits reconnect, and the Registry bumps the generation for already-open workspaces.
   *
   * Routing is the same as for stop: when the Source has a recovery intent, its connection and in-memory credentials are reused; otherwise the caller resolves, by default the connection or most recent connection,
   * a connection whose credentials can be obtained silently.
   */
  public async restartSource(input: {
    sourceServerId: string;
    resolveOfflineRoute: () => Promise<SourceOperationRoute>;
  }): Promise<ManagedSourceServerConnection> {
    const { sourceServerId } = input;
    // Must reject before writing the operation log: a rejected restart must not overwrite the log of the operation in progress.
    this.assertLifecycleOperationCanStart(sourceServerId, "restart");
    const { profile, target } = await this.resolveSourceOperationRoute(input);
    // Reading credentials for an offline route yields execution, and other lifecycle operations may register during that time.
    this.assertLifecycleOperationCanStart(sourceServerId, "restart");
    const flight = this.registerLifecycleOperation("restart", profile.profileId, sourceServerId);
    const { controller } = flight;
    try {
      return await this.operationLogs.run(
        "restart",
        profile,
        target,
        { signal: controller.signal },
        async (context) => {
          const previousState = this.getStateByProfile(profile.profileId);
          this.clearRecoveryTimers(sourceServerId);
          // No new Host state: during restart the projection is "connecting", not updating, and it carries no automatic retry count.
          this.setState(profile.profileId, { state: "bootstrapping", sourceServerId });
          try {
            const status = readServerCommandResult(
              await this.getAdapter(profile.transport).exec(target, ["restart", "--json"], context),
              "Remote service failed to restart",
            );
            // Older remotes treat restart as an ack that only swaps Core; the connection may start only once the new daemon is ready.
            if (status.state !== "ready") {
              throw new Error("Remote service did not confirm that it restarted");
            }
            controller.signal.throwIfAborted();
            // Bug cause: after the old remote process exits, the WS close may arrive later than the command's return; the connection flow would treat the connection still registered as online
            // as reusable and return directly, and the late close would then schedule a retry as an ordinary disconnect. Invalidate it proactively before connecting.
            const online = this.onlineBySourceServerId.get(sourceServerId);
            if (online) {
              this.invalidateOnlineConnectionForLifecycleOperation(
                sourceServerId,
                online,
                "restart",
              );
            }
            // An invalidation event's synchronous subscribers may also submit a disconnect, so this must not enter the connection flow after that terminal state.
            controller.signal.throwIfAborted();
            // The reconnect event is fired uniformly at connectOnce's publish point.
            return await this.connectForSource({ profile, target, context }, sourceServerId, false);
          } catch (error) {
            // A disconnect, removal, or release has already published a terminal state; an aborted restart must not write back its state.
            controller.signal.throwIfAborted();
            this.settleFailedLifecycleOperation({
              kind: "restart",
              profileId: profile.profileId,
              sourceServerId,
              previousState,
              error,
            });
            throw error;
          }
        },
      );
    } finally {
      this.lifecycleOperationFlights.delete(flight);
      this.releaseTargetTransport(target);
    }
  }

  /**
   * Stops the remote service on the device (RDLC-01, R3 §8.4.5). First fully performs explicit-disconnect teardown (clears timers, aborts in-flight connections,
   * deletes the recovery intent, releases the connection, and sets offline), then runs `stop --wait --json` through the transport. The recovery intent is already deleted,
   * so connection closes caused by the remote exiting do not schedule retries or offline probes; both success and failure stay offline.
   *
   * Routing: while the Source still has a recovery intent (online, retrying, or offline probing), its connection and in-memory credentials are reused;
   * otherwise the caller resolves a connection, by default the connection or most recent connection, whose credentials can be obtained silently.
   */
  public async stopSource(input: {
    sourceServerId: string;
    resolveOfflineRoute: () => Promise<SourceOperationRoute>;
  }): Promise<void> {
    const { sourceServerId } = input;
    // Must reject before writing the operation log: a rejected stop must not overwrite the log of the operation in progress.
    this.assertLifecycleOperationCanStart(sourceServerId, "stop");
    const route = await this.resolveSourceOperationRoute(input);
    // Reading credentials for an offline route yields execution, and other lifecycle operations may have registered in the meantime; this must be rechecked before the explicit disconnect
    // (which aborts all flights of the same Source), otherwise the disconnect would abort the operation in progress first.
    this.assertLifecycleOperationCanStart(sourceServerId, "stop");
    // When the route is taken from the recovery intent, the route.target handed back by the disconnect is used: the remote command reuses its session without re-authenticating, and it is released after completion.
    this.disconnectSource(sourceServerId);
    const profileId = route.profile.profileId;
    const flight = this.registerLifecycleOperation("stop", profileId, sourceServerId);
    const { controller } = flight;
    // Clears the reason left on this connection by the previous failed stop; the device stays disconnected for the whole stop process.
    this.setState(profileId, { state: "offline", sourceServerId });
    try {
      await this.operationLogs.run(
        "stop",
        route.profile,
        route.target,
        { signal: controller.signal },
        async (context) => {
          const status = readServerCommandResult(
            await this.getAdapter(route.profile.transport).exec(
              route.target,
              ["stop", "--wait", "--json"],
              context,
            ),
            "Remote service failed to stop",
          );
          // Older remotes without --wait only return an ack; only a final stopped state may be reported as "stopped".
          if (status.state !== "stopped" && status.state !== "uninstalled") {
            throw new Error("Remote service did not confirm that it stopped");
          }
          return { sourceServerId, profileId };
        },
      );
      controller.signal.throwIfAborted();
    } catch (error) {
      // A disconnect, removal, or release has already published a terminal state; an aborted stop must not write back its state.
      controller.signal.throwIfAborted();
      // The device stays disconnected; the failure reason stays on this connection's state for classified display in the failure details.
      this.setState(profileId, {
        state: "offline",
        sourceServerId,
        ...describeLifecycleOperationFailure(error),
      });
      throw error;
    } finally {
      this.lifecycleOperationFlights.delete(flight);
      this.releaseTargetTransport(route.target);
    }
  }

  public disconnect(sourceServerId: string): void {
    const droppedTarget = this.disconnectSource(sourceServerId);
    if (droppedTarget) this.releaseTargetTransport(droppedTarget);
  }

  public removeProfile(profileId: string): void {
    this.operationLogs.removeProfile(profileId);
    this.pendingHostKeys.delete(profileId);
    // Record canceled expected-disconnect operations and their kinds; teardown judges the projection each one left on the recovery owner by its kind.
    const canceledExpectedDisconnects = new Map<string, ExpectedDisconnectOperationKind>();
    for (const flight of this.lifecycleOperationFlights) {
      if (flight.profileId !== profileId) continue;
      if (flight.sourceServerId && flight.kind !== "stop") {
        canceledExpectedDisconnects.set(flight.sourceServerId, flight.kind);
      }
      this.lifecycleOperationFlights.delete(flight);
      flight.controller.abort(new SourceServerProfileRemovedError(profileId));
    }
    const connectingSourceServerId = this.connectFlights.get(profileId)?.sourceServerId;
    const sourceOwnedOnlyByConnectingProfile =
      connectingSourceServerId &&
      !this.reconnectInputs.has(connectingSourceServerId) &&
      !this.onlineBySourceServerId.has(connectingSourceServerId)
        ? connectingSourceServerId
        : undefined;
    const currentSourceServerId =
      [...this.reconnectInputs].find(([, input]) => input.profile.profileId === profileId)?.[0] ??
      [...this.onlineBySourceServerId].find(([, online]) => online.profileId === profileId)?.[0] ??
      sourceOwnedOnlyByConnectingProfile;
    if (currentSourceServerId) {
      // Bug cause: after Directory removes the current route, the old implementation only deleted the display state, while the recovery owner, timers, and
      // resolved secret still lived on, and after a disconnect it would keep using the removed route. Removing the current route is equivalent to explicitly
      // disconnecting the whole Source; other routes can only be selected manually by the user later and must not be silently taken over here.
      const droppedTarget = this.disconnectSource(currentSourceServerId, profileId);
      if (droppedTarget) this.releaseTargetTransport(droppedTarget);
      return;
    }

    const flight = this.connectFlights.get(profileId);
    if (flight) {
      this.connectFlights.delete(profileId);
      flight.controller.abort(new SourceServerProfileRemovedError(profileId));
    }
    for (const online of this.onlineBySourceServerId.values()) {
      online.profileIds.delete(profileId);
    }
    this.states.delete(profileId);
    this.compatibilityByProfileId.delete(profileId);
    for (const [sourceServerId, profileIds] of this.profileIdsBySourceServerId) {
      if (!profileIds.delete(profileId)) continue;
      if (profileIds.size === 0) this.profileIdsBySourceServerId.delete(sourceServerId);
    }
    // Bug cause: updates or restarts on a non-current route may already have removed the old physical connection; after cancellation the operation teardown is skipped, and the original owner
    // would stay permanently in that operation's projection (updating for update, bootstrapping for restart). Deleting the operation hands back the recovery intent that is still kept,
    // without depending on the late result of the canceled operation. The projection is judged by the kind of the canceled flight, not inferred from the state.
    for (const [sourceServerId, kind] of canceledExpectedDisconnects) {
      const input = this.reconnectInputs.get(sourceServerId);
      if (
        input &&
        !this.onlineBySourceServerId.has(sourceServerId) &&
        this.getStateByProfile(input.profile.profileId).state ===
          expectedDisconnectProjection(kind) &&
        // If the owner itself already has an in-flight connection, that connection finishes the teardown and must not schedule another retry.
        !this.connectFlights.has(input.profile.profileId) &&
        !this.expectedDisconnectOperation(sourceServerId)
      )
        this.scheduleOnlineRetry(sourceServerId, 0);
    }
  }

  /**
   * Explicit-disconnect teardown. Returns the removed recovery-intent target: its transport session is released by the caller (stop must first use it to run the remote command).
   */
  private disconnectSource(
    sourceServerId: string,
    removedProfileId?: string,
  ): Exclude<RemoteTarget, { kind: "server" }> | undefined {
    const online = this.onlineBySourceServerId.get(sourceServerId);
    const reconnectInput = this.reconnectInputs.get(sourceServerId);
    const profileIds = new Set(this.profileIdsBySourceServerId.get(sourceServerId) ?? []);
    for (const profileId of online?.profileIds ?? []) profileIds.add(profileId);
    if (reconnectInput) profileIds.add(reconnectInput.profile.profileId);
    for (const flight of this.lifecycleOperationFlights) {
      if (flight.sourceServerId !== sourceServerId) continue;
      this.lifecycleOperationFlights.delete(flight);
      flight.controller.abort(new SourceServerExplicitDisconnectError(sourceServerId));
      profileIds.add(flight.profileId);
    }

    // Bug cause: an unexpected disconnect removes the online owner first; if explicit disconnect then judged the lifecycle by whether an online entry exists,
    // it would only clear the timer and leave retrying stuck forever. All profiles of the Source must be captured before the recovery index is deleted,
    // in-flight Source flights must be aborted, and an offline terminal state must be published whether or not a physical connection still exists; otherwise
    // a late success already in bootstrapping would overwrite the offline intent the user just submitted.
    this.clearRecoveryTimers(sourceServerId);
    for (const [profileId, flight] of this.connectFlights) {
      if (flight.sourceServerId !== sourceServerId) continue;
      if (this.connectFlights.get(profileId) === flight) {
        this.connectFlights.delete(profileId);
      }
      flight.controller.abort(
        profileId === removedProfileId
          ? new SourceServerProfileRemovedError(profileId)
          : new SourceServerExplicitDisconnectError(sourceServerId),
      );
      profileIds.add(profileId);
    }
    if (removedProfileId) profileIds.delete(removedProfileId);
    this.reconnectInputs.delete(sourceServerId);
    this.profileIdsBySourceServerId.delete(sourceServerId);
    if (online) this.onlineBySourceServerId.delete(sourceServerId);
    if (removedProfileId) {
      this.connectionInvalidatedEmitter.fire({
        sourceServerId,
        reason: "profile-removed",
        recoverable: false,
      });
    }
    online?.projectSubscription?.dispose();
    online?.connection.dispose();
    for (const profileId of profileIds) {
      this.setState(profileId, { state: "offline", sourceServerId });
    }
    if (removedProfileId) {
      this.states.delete(removedProfileId);
      this.pendingHostKeys.delete(removedProfileId);
      this.compatibilityByProfileId.delete(removedProfileId);
    }
    return reconnectInput?.target;
  }

  public dispose(): void {
    const reason = Object.assign(new Error("Source Server manager disposed"), {
      code: "remote-connection-canceled",
    });
    for (const flight of this.lifecycleOperationFlights) flight.controller.abort(reason);
    this.lifecycleOperationFlights.clear();
    this.pendingHostKeys.clear();
    // A late reconnect of an update may have no online owner yet, so in-flight connections cannot be reclaimed by iterating only the online table.
    for (const flight of this.connectFlights.values()) flight.controller.abort(reason);
    this.connectFlights.clear();
    for (const sourceServerId of this.retryTimers.keys()) this.clearRecoveryTimers(sourceServerId);
    for (const sourceServerId of this.offlineProbeTimers.keys())
      this.clearRecoveryTimers(sourceServerId);
    // Offline recovery also holds the connection intent; clearing only online would let a late catch from an aborted flight schedule a retry again.
    for (const sourceServerId of new Set([
      ...this.reconnectInputs.keys(),
      ...this.onlineBySourceServerId.keys(),
    ])) {
      this.disconnect(sourceServerId);
    }
    for (const adapter of this.adapters.values()) adapter.dispose?.();
    this.adapters.clear();
    this.stateEmitter.dispose();
    this.reconnectEmitter.dispose();
    this.connectionInvalidatedEmitter.dispose();
    this.operationLogs.dispose();
  }

  private async connectOnce(
    options: ConnectSourceServerOptions,
    explicitDisconnectSignal?: AbortSignal,
  ): Promise<ManagedSourceServerConnection> {
    const { profile, target } = options;
    if (target.kind === "server" || profile.transport !== target.kind) {
      throw new Error(
        `Connection Profile ${profile.profileId} transport does not match target ${target.kind}`,
      );
    }
    const signal = options.context?.signal;
    let unpublishedConnection: ServerRemoteConnection | undefined;
    const throwIfAborted = () => {
      explicitDisconnectSignal?.throwIfAborted();
      signal?.throwIfAborted();
    };
    throwIfAborted();
    let commitMembership: ((sourceServerId: string) => Promise<void>) | undefined;
    if (this.options.admitConnection) {
      try {
        commitMembership = await this.options.admitConnection({
          profile,
          intent: options.membershipIntent ?? "retain",
          confirmIdentityChange: options.confirmIdentityChange === true,
        });
      } catch (error) {
        // Once the route has been removed, a late admission error no longer has the right to rebuild a failed display row.
        throwIfAborted();
        this.setState(profile.profileId, {
          state: "failed",
          error: error instanceof Error ? error.message : String(error),
          retryable: false,
        });
        throw error;
      }
    }
    throwIfAborted();
    if (profile.sourceServerId) {
      const existing = this.onlineBySourceServerId.get(profile.sourceServerId);
      if (existing) {
        await commitMembership?.(profile.sourceServerId);
        // Reuse also goes through the asynchronous membership commit; this wait may have been ended by a user disconnect, so the old socket must not be returned.
        throwIfAborted();
        if (this.onlineBySourceServerId.get(profile.sourceServerId) !== existing)
          throw new Error("Source Server connection changed during admission");
        existing.profileIds.add(profile.profileId);
        this.rememberSourceProfiles(profile.sourceServerId, existing.profileIds);
        this.setState(profile.profileId, {
          state: "online",
          sourceServerId: profile.sourceServerId,
        });
        return this.reusedConnection(existing);
      }
    }
    this.setState(profile.profileId, { state: "bootstrapping" });
    const adapter = this.getAdapter(profile.transport);
    let targetTransportCancelled = false;
    const cancelTargetTransport = () => {
      if (targetTransportCancelled) return;
      targetTransportCancelled = true;
      adapter.cancel?.(target);
    };
    if (signal?.aborted || explicitDisconnectSignal?.aborted) {
      cancelTargetTransport();
      throwIfAborted();
    }
    signal?.addEventListener("abort", cancelTargetTransport, { once: true });
    explicitDisconnectSignal?.addEventListener("abort", cancelTargetTransport, { once: true });
    let ignoreConnectionClose = false;
    try {
      options.onDiagnosticPhase?.("probe");
      const shouldRefreshDevelopmentArtifact =
        this.options.sourceServerArtifactPolicy === "development-content-addressed" &&
        target.kind === "ssh";
      const probe = await adapter.probe(
        target,
        options.context ?? {},
        shouldRefreshDevelopmentArtifact ? { includeReleaseIdentity: true } : undefined,
      );
      throwIfAborted();
      if (probe.installed) {
        const installedVersion = probe.installedVersion?.trim() || "unknown";
        let compatibleInstalledVersion = false;
        try {
          compatibleInstalledVersion =
            compareCompatibilityVersions(
              installedVersion,
              this.compatibilityManifest.minCompatibleVersion,
            ) >= 0;
        } catch {
          // Bug cause: pre-R3 or corrupted installs may return an empty value/unknown. Continuing to run the new version's ensureDaemon
          // would only turn into a generic failed at the ingress-token contract, and the user would also lose the upgrade entry point.
          compatibleInstalledVersion = false;
        }
        if (!compatibleInstalledVersion) {
          this.setState(profile.profileId, {
            state: "needs-upgrade",
            updateAvailability: "required",
            currentVersion: installedVersion,
            availableVersion: this.compatibilityManifest.productVersion,
            minimumVersion: this.compatibilityManifest.minCompatibleVersion,
            upgradeTarget: "server",
            // When the remote is explicitly switched back by an older Desktop, the wizard must wait for user confirmation before upgrading, and must not silently override the other side's choice.
            ...(probe.downgradedFrom ? { downgradedFrom: probe.downgradedFrom } : {}),
            errorCode: SOURCE_SERVER_UPGRADE_REQUIRED_ERROR_CODE,
            retryable: false,
          });
          throw new SourceServerUpgradeRequiredError(
            profile.profileId,
            "server",
            installedVersion,
            this.compatibilityManifest.minCompatibleVersion,
          );
        }
        if (
          shouldRefreshDevelopmentArtifact &&
          installedVersion === this.compatibilityManifest.productVersion
        ) {
          const releaseResolver = options.resolveRelease ?? this.options.resolveRelease;
          if (!releaseResolver) {
            throw new Error("Development Source Server release is unavailable");
          }
          const release = await releaseResolver(probe, target);
          throwIfAborted();
          if (
            release.version === installedVersion &&
            release.sha256.toLowerCase() !== probe.installedArchiveSha256?.toLowerCase()
          ) {
            // Bug cause (R3A-B-06): the development-mode same-version refresh used to call installOrUpdate directly here, bypassing
            // updateServer's updating state, operation log, and force-guard confirmation; when the remote had running tasks, the guard
            // could only show as an ordinary connection failure, and the UI had no "force update" entry and would not retry after the tasks ended.
            // Development and production differ only in how "needs an update" is decided (SHA vs version compatibility); after that decision they must
            // follow the same needs-upgrade → updateSource/updateServer chain, and the connection flow itself does not perform the update.
            this.setState(profile.profileId, {
              state: "needs-upgrade",
              updateAvailability: "required",
              currentVersion: installedVersion,
              availableVersion: release.version,
              minimumVersion: this.compatibilityManifest.minCompatibleVersion,
              upgradeTarget: "server",
              errorCode: SOURCE_SERVER_UPGRADE_REQUIRED_ERROR_CODE,
              retryable: false,
            });
            throw new SourceServerUpgradeRequiredError(
              profile.profileId,
              "server",
              installedVersion,
              this.compatibilityManifest.minCompatibleVersion,
              "development-archive",
            );
          }
        }
      }
      if (!probe.installed) {
        if (profile.sourceServerId) {
          await this.options.directory.markSourceUninstalled?.(profile.profileId);
          throwIfAborted();
        }
        const releaseResolver = options.resolveRelease ?? this.options.resolveRelease;
        const release =
          options.release ??
          (options.allowInstall && releaseResolver
            ? await releaseResolver(probe, target)
            : undefined);
        throwIfAborted();
        if (!release) {
          // The preview is supplementary information; when CDN/cache metadata is unavailable, the install wait point is still kept. The actual install resolution still fails strictly.
          const previewRelease = releaseResolver
            ? await releaseResolver(probe, target, { metadataOnly: true }).catch(() => undefined)
            : undefined;
          throwIfAborted();
          this.setState(profile.profileId, {
            ...(previewRelease
              ? {
                  installPreview: {
                    version: previewRelease.version,
                    sizeBytes: previewRelease.sizeBytes,
                    ...(probe.installPath ? { installPath: probe.installPath } : {}),
                  },
                }
              : {}),
            state: "needs-install",
            ...(profile.sourceServerId ? { sourceServerId: profile.sourceServerId } : {}),
            errorCode: SOURCE_SERVER_INSTALL_REQUIRED_ERROR_CODE,
            retryable: false,
          });
          throw new SourceServerInstallRequiredError(profile.profileId);
        }
        await adapter.installOrUpdate(target, release, options.context ?? {});
        throwIfAborted();
      }
      options.onDiagnosticPhase?.("daemon");
      const ingress = await adapter.ensureDaemon(target, options.context ?? {}, {
        observedStatus: probe.daemonStatus,
      });
      throwIfAborted();
      let published: { sourceServerId: string; connection: ServerRemoteConnection } | undefined;
      let closedBeforePublish: string | undefined;
      // Only the close event of the current handshake counts: a late close from a connection of a failed handshake must not count toward the handshake after fallback.
      let liveHandshake: object | undefined;
      const onHandshakeClose = (attempt: object, reason: string) => {
        if (ignoreConnectionClose || liveHandshake !== attempt) return;
        // Bug cause (RV-P1-1): the close event used to be routed only by sourceServerId, and guarded by whether an online-table entry existed.
        // If the connection closed during handshake persistence (recordHandshake), the online table was either empty (the event was dropped, and the already-closed
        // connection was then published as online), or pointed at another healthy connection of the same Source (a sibling's close would tear down the online
        // owner and clear its retries). Before publish, only record the close fact and let the publish point settle it as a connection failure; process it after publish,
        // and always carry this connection's identity so a close only affects the connection it belongs to.
        if (!published) {
          closedBeforePublish = reason || "connection closed";
          return;
        }
        this.handleUnexpectedClose(published.sourceServerId, reason, published.connection);
      };
      const handshake = async (daemon: SourceServerIngressInfo) => {
        const attempt = {};
        liveHandshake = attempt;
        // Bug cause: when ws fails an upgrade it emits error and then close in the same tick, so the close callback runs before the catch below,
        // and liveHandshake cannot stop it. A close record left by the previous handshake would make the healthy connection after fallback be judged closed at the publish point.
        // The close record belongs only to the current handshake, so it is cleared when the handshake starts.
        closedBeforePublish = undefined;
        try {
          return await this.connectServer({
            ingressToken: daemon.ingressToken,
            createConnection: async () =>
              await adapter.openChannel(target, daemon, options.context ?? {}),
            onClose: ({ reason }) => onHandshakeClose(attempt, reason),
          });
        } catch (error) {
          liveHandshake = undefined;
          throw error;
        }
      };
      options.onDiagnosticPhase?.("protocol-handshake");
      let connection: ServerRemoteConnection;
      try {
        connection = await handshake(ingress);
      } catch (error) {
        throwIfAborted();
        if (!ingress.reusedProbeStatus) throw error;
        // Bug cause: probe reused the port just because status.json says ready and the Core PID passes kill -0. After a remote restart the snapshot remains stale,
        // the PID is reused by another process of the same user, no one listens on the port any more, the handshake reports socket hang up, and the daemon is never restarted.
        // The snapshot is only an optimization that saves one serve --daemon; when the handshake fails, fall back once, and let serve --daemon read the live Supervisor state via control,
        // taking over a stale lock and restarting if needed.
        this.options.logWarn?.(
          "reused Source Server did not answer the handshake; running serve --daemon",
          error instanceof Error ? error : new Error(String(error)),
        );
        options.context?.onLog?.({
          phase: "daemon",
          message: "Reused Source Server did not respond; checking it with serve --daemon",
        });
        options.onDiagnosticPhase?.("daemon");
        const restarted = await adapter.ensureDaemon(target, options.context ?? {});
        throwIfAborted();
        options.onDiagnosticPhase?.("protocol-handshake");
        connection = await handshake(restarted);
      }
      unpublishedConnection = connection;
      throwIfAborted();
      const compatibility = connection.serverInfo.compatibility;
      if (!compatibility) {
        this.setState(profile.profileId, {
          state: "needs-upgrade",
          updateAvailability: "required",
          currentVersion: connection.serverInfo.version,
          availableVersion: this.compatibilityManifest.productVersion,
          minimumVersion: this.compatibilityManifest.minCompatibleVersion,
          upgradeTarget: "server",
          errorCode: SOURCE_SERVER_UPGRADE_REQUIRED_ERROR_CODE,
          retryable: false,
        });
        throw new SourceServerUpgradeRequiredError(
          profile.profileId,
          "server",
          connection.serverInfo.version,
          this.compatibilityManifest.minCompatibleVersion,
        );
      }
      const compatibilityResult = evaluateSourceServerCompatibility(
        this.compatibilityManifest,
        compatibility,
      );
      const compatibilityState = buildCompatibilityState(this.compatibilityManifest, compatibility);
      if (!compatibilityResult.compatible && compatibilityResult.upgradeTarget) {
        this.setState(profile.profileId, {
          state: "needs-upgrade",
          ...compatibilityState,
          errorCode: SOURCE_SERVER_UPGRADE_REQUIRED_ERROR_CODE,
          retryable: false,
        });
        throw new SourceServerUpgradeRequiredError(
          profile.profileId,
          compatibilityResult.upgradeTarget,
          compatibilityResult.olderVersion,
          compatibilityResult.requiredMinimumVersion,
        );
      }
      const sourceServerId = connection.serverInfo.serverId;
      const connectedAt = this.now();
      options.onDiagnosticPhase?.("directory-record");
      const handshakeResult = await this.options.directory.recordHandshake(
        profile.profileId,
        {
          sourceServerId,
          osUser: connection.serverInfo.identity?.osUser,
          hostname: connection.serverInfo.identity?.hostname,
          version:
            connection.serverInfo.compatibility?.productVersion ?? connection.serverInfo.version,
          connectedAt,
          workspaces: connection.serverInfo.workspaces,
        },
        ...(options.confirmIdentityChange ? [{ confirmIdentityChange: true }] : []),
      );
      throwIfAborted();
      if (handshakeResult.identityChanged && options.confirmIdentityChange !== true) {
        this.setState(profile.profileId, {
          state: "identity-change-pending",
          sourceServerId: profile.sourceServerId,
          pendingSourceServerId: sourceServerId,
          errorCode: SOURCE_SERVER_IDENTITY_CHANGE_PENDING_ERROR_CODE,
          retryable: false,
        });
        throw new SourceServerIdentityChangePendingError(profile.profileId, sourceServerId);
      }
      const effectiveProfile = handshakeResult.effectiveProfile ?? profile;
      // If the connection closed when the directory was written, membership must not be committed; a healthy sibling owner can continue to take over this admission.
      if (closedBeforePublish !== undefined && !this.onlineBySourceServerId.has(sourceServerId))
        throw new SourceServerHandshakeClosedError(closedBeforePublish);
      await commitMembership?.(sourceServerId);
      throwIfAborted();
      options.onDiagnosticPhase?.("publish-online");
      if (effectiveProfile.profileId !== profile.profileId) {
        this.setState(profile.profileId, {
          state: "offline",
          ...(profile.sourceServerId ? { sourceServerId: profile.sourceServerId } : {}),
        });
      }

      const existing = this.onlineBySourceServerId.get(sourceServerId);
      if (existing) {
        existing.profileIds.add(effectiveProfile.profileId);
        this.rememberSourceProfiles(sourceServerId, existing.profileIds);
        this.setState(effectiveProfile.profileId, {
          state: "online",
          sourceServerId,
          ...compatibilityState,
        });
        return this.reusedConnection(existing);
      }
      if (closedBeforePublish !== undefined) {
        // The connection died during the handshake: it cannot be published, so throw as an ordinary connection failure, letting a manual connect show a retryable failure
        // and the automatic recovery path continue with the next tier. Placed after the sibling join: join is the correct result only when the owner is healthy.
        throw new SourceServerHandshakeClosedError(closedBeforePublish);
      }
      const managed: OnlineConnection = {
        sourceServerId,
        profileId: effectiveProfile.profileId,
        serverInfo: connection.serverInfo,
        services: connection.services,
        connection,
        profileIds: new Set([effectiveProfile.profileId]),
      };
      if (this.options.onProjectChange) {
        managed.projectSubscription = connection.services.broadcastService.onMessage((event) => {
          // A late broadcast after a generation change or disconnect cannot represent the current Source; the notification only triggers a read and carries no project data.
          if (
            event.channel === "state:projects" &&
            this.onlineBySourceServerId.get(sourceServerId) === managed
          )
            this.options.onProjectChange?.(sourceServerId);
        });
      }
      // Bug cause: onDidReconnect used to be attached only to the retry/probe timer callbacks and to updateServer;
      // during retrying/offline, a manual connect (connectProfile / confirmIdentityChange) succeeded via connect(), and the Manager cleared the pending retry timer
      // and published online without firing reconnect. The Host wrapper only swaps services on reconnect, so the Registry entry's recoveryReady was never resolved;
      // new connects on the same route waited forever. reconnectInputs is only written on first publish and deleted on explicit disconnect,
      // so "publishing the same Source again" is the only source of truth for reconnects: whichever path triggers a connection,
      // a transition from not-online to online fires reconnect here.
      const isRepublish = this.reconnectInputs.has(sourceServerId);
      const replacedTarget = this.reconnectInputs.get(sourceServerId)?.target;
      this.onlineBySourceServerId.set(sourceServerId, managed);
      published = { sourceServerId, connection };
      unpublishedConnection = undefined;
      this.rememberSourceProfiles(sourceServerId, managed.profileIds);
      this.clearRecoveryTimers(sourceServerId);
      this.reconnectInputs.set(sourceServerId, {
        profile: effectiveProfile,
        target,
        // The operation-level onLog captures this run's logs and credentials; recovery must not hold the old closure, and the next operation rebuilds its log context.
        context: {},
      });
      this.pendingHostKeys.delete(profile.profileId);
      // Bug cause: when an update, identity confirmation, or other flow republishes with a new target, the old target's session lost its owner and was kept until Host exit, leaving one idle SSH connection to the device per update. Release the old session when the recovery intent switches target.
      if (replacedTarget) this.releaseTargetTransport(replacedTarget);
      this.setState(effectiveProfile.profileId, {
        state: "online",
        sourceServerId,
        ...compatibilityState,
      });
      if (isRepublish) this.reconnectEmitter.fire(managed);
      return managed;
    } catch (error) {
      if (
        error instanceof SourceServerUpgradeRequiredError &&
        !signal?.aborted &&
        !explicitDisconnectSignal?.aborted
      ) {
        await options.onAuthenticatedUpgradeRequired?.();
      }
      if (explicitDisconnectSignal?.aborted) {
        throw explicitDisconnectSignal.reason;
      }
      if (
        error instanceof SourceServerInstallRequiredError ||
        error instanceof SourceServerUpgradeRequiredError ||
        error instanceof SourceServerIdentityChangePendingError
      )
        throw error;
      const normalized = normalizeRemoteConnectionError(error);
      const errorCode = isPublicZCodeErrorCode(normalized.code) ? normalized.code : undefined;
      const retryable =
        error && typeof error === "object" && "retryable" in error
          ? (error as { retryable?: unknown }).retryable
          : undefined;
      const unknownHostKey = readUnknownHostKey(error);
      if (unknownHostKey) {
        this.pendingHostKeys.set(profile.profileId, unknownHostKey);
        Object.assign(findHostKeyError(error) as object, { profileId: profile.profileId });
      } else this.pendingHostKeys.delete(profile.profileId);
      this.setState(profile.profileId, {
        state: "failed",
        error: normalized.message,
        ...(errorCode ? { errorCode } : {}),
        ...(typeof retryable === "boolean" ? { retryable } : {}),
        ...(unknownHostKey
          ? {
              hostKeyPreview: {
                keyType: unknownHostKey.keyType,
                fingerprint: unknownHostKey.fingerprint,
              },
            }
          : {}),
      });
      throw error;
    } finally {
      signal?.removeEventListener("abort", cancelTargetTransport);
      explicitDisconnectSignal?.removeEventListener("abort", cancelTargetTransport);
      // Bug cause: the in-branch release missed handshake-persistence rejection and compatible-version parse errors, so recovery retries accumulated connections.
      // Handshake, directory write, identity confirmation, and membership commit share this single unpublished-resource exit; until the online table takes over, this attempt always owns the connection,
      // so it is released uniformly and its close event is ignored, avoiding effects on the successor owner.
      if (unpublishedConnection) {
        ignoreConnectionClose = true;
        unpublishedConnection.dispose();
      }
    }
  }

  private getAdapter(kind: "ssh" | "wsl" | "docker"): SourceServerTransportAdapter {
    let adapter = this.adapters.get(kind);
    if (!adapter) {
      adapter = this.createAdapter(kind);
      this.adapters.set(kind, adapter);
    }
    return adapter;
  }

  /**
   * Releases the target's transport session (SSH connection, WSL child process, etc., including credentials in it). Kept while the recovery intent still holds the same target,
   * for reuse by retries, offline probes, and device operations.
   *
   * Bug cause: the Adapter caches sessions per target object and only closes them when a connection is aborted or the Host releases it; explicit disconnect, stop, a recovery intent switching target,
   * and one-off operations ending all left them unreleased, so after stopping the remote service the local machine stayed connected to the device. The owner of a target releases it here on exit.
   */
  private releaseTargetTransport(target: RemoteTarget): void {
    for (const input of this.reconnectInputs.values()) {
      if (input.target === target) return;
    }
    this.adapters.get(target.kind)?.cancel?.(target);
  }

  private handleUnexpectedClose(
    sourceServerId: string,
    reason: string,
    connection: ServerRemoteConnection,
  ): void {
    const online = this.onlineBySourceServerId.get(sourceServerId);
    // Only handle the close of the current online owner; a late close from a connection that was replaced or never published must not tear down its successor.
    if (!online || online.connection !== connection) return;
    // A lifecycle operation makes the remote drop the connection on purpose: only invalidate the connection, do not remove the recovery intent, and do not schedule retries.
    const expectedDisconnect = this.expectedDisconnectOperation(sourceServerId);
    if (expectedDisconnect) {
      this.invalidateOnlineConnectionForLifecycleOperation(
        sourceServerId,
        online,
        expectedDisconnect,
      );
      return;
    }
    this.onlineBySourceServerId.delete(sourceServerId);
    // Bug cause: after an unexpected disconnect the old RPC generation was only removed from the online table, without explicitly releasing protocol/socket;
    // repeated reconnects made old-generation pending state depend on GC. Remove the owner first and then dispose; repeated close callbacks
    // return idempotently because the online table no longer has this Source.
    online.projectSubscription?.dispose();
    online.connection.dispose();
    for (const profileId of online.profileIds) {
      this.setState(profileId, {
        state: "retrying",
        sourceServerId,
        ...(reason ? { error: reason } : {}),
        recoveryAttempt: 1,
        recoveryLimit: ONLINE_RETRY_DELAYS_MS.length,
      });
    }
    this.scheduleOnlineRetry(sourceServerId, 0);
  }

  /**
   * Makes the closing of an online connection an "expected disconnect" operation (update or restart; by the mutual-exclusion matrix they never coexist). Before a stop runs the remote command,
   * the recovery intent has been deleted and the connection released; a new connection the user establishes in the meantime is recovered as an ordinary disconnect and must not be swallowed as a generation change.
   */
  private expectedDisconnectOperation(
    sourceServerId: string,
  ): ExpectedDisconnectOperationKind | undefined {
    for (const flight of this.lifecycleOperationFlights) {
      if (flight.sourceServerId === sourceServerId && flight.kind !== "stop") return flight.kind;
    }
    return undefined;
  }

  /** Same-Source mutual exclusion: stop and restart are exclusive with every operation; multiple updates may coexist through sibling Profiles, as before. */
  private assertLifecycleOperationCanStart(
    sourceServerId: string,
    kind: LifecycleOperationKind,
  ): void {
    const conflict = [...this.lifecycleOperationFlights].some(
      (flight) =>
        flight.sourceServerId === sourceServerId && (kind !== "update" || flight.kind !== "update"),
    );
    if (conflict) throw new SourceServerLifecycleOperationInProgressError(sourceServerId);
  }

  /**
   * The only entry point for registering a lifecycle operation flight. The caller must first complete the mutual-exclusion check (recheck after yielding execution), and register before writing
   * the operation log; the flight is removed by the same caller after the operation log ends.
   */
  private registerLifecycleOperation(
    kind: LifecycleOperationKind,
    profileId: string,
    sourceServerId: string | undefined,
  ): LifecycleOperationFlight {
    const flight: LifecycleOperationFlight = {
      kind,
      profileId,
      sourceServerId,
      controller: new AbortController(),
    };
    this.lifecycleOperationFlights.add(flight);
    return flight;
  }

  private invalidateOnlineConnectionForLifecycleOperation(
    sourceServerId: string,
    online: OnlineConnection,
    operation: ExpectedDisconnectOperationKind,
  ): void {
    if (this.onlineBySourceServerId.get(sourceServerId) !== online) return;
    // Bug cause: an explicit update used to replace only the physical connection inside the Manager, without first invalidating the logical workspace still pointing at the old services;
    // after a successful update the UI showed online, but scoped RPC still hit the closed generation.
    // Remove the physical owner and publish one Source-level invalidation first, then release the connection, so the Registry can fail closed and then bump the generation.
    this.onlineBySourceServerId.delete(sourceServerId);
    for (const profileId of online.profileIds) {
      this.setState(profileId, { state: expectedDisconnectProjection(operation), sourceServerId });
    }
    this.connectionInvalidatedEmitter.fire({ sourceServerId, reason: operation });
    online.projectSubscription?.dispose();
    online.connection.dispose();
  }

  private scheduleOnlineRetry(sourceServerId: string, attempt: number): void {
    const input = this.reconnectInputs.get(sourceServerId);
    const delay = ONLINE_RETRY_DELAYS_MS[attempt];
    if (!input || delay === undefined) {
      this.enterOfflineProbe(sourceServerId);
      return;
    }
    const existing = this.retryTimers.get(sourceServerId);
    if (existing) clearTimeout(existing);
    for (const profileId of this.profileIdsForSource(sourceServerId, input.profile.profileId)) {
      this.setState(profileId, {
        state: "retrying",
        sourceServerId,
        recoveryAttempt: attempt + 1,
        recoveryLimit: ONLINE_RETRY_DELAYS_MS.length,
      });
    }
    const timer = setTimeout(() => {
      this.retryTimers.delete(sourceServerId);
      void this.connectForSource(
        {
          profile: input.profile,
          target: input.target,
          context: input.context,
        },
        sourceServerId,
      ).catch((error) => {
        if (
          error instanceof SourceServerExplicitDisconnectError ||
          error instanceof SourceServerProfileRemovedError ||
          this.stopAutomaticRecoveryForTerminalFailure(sourceServerId, error)
        ) {
          return;
        }
        if (attempt + 1 < ONLINE_RETRY_DELAYS_MS.length) {
          this.scheduleOnlineRetry(sourceServerId, attempt + 1);
        } else {
          this.enterOfflineProbe(sourceServerId, error);
        }
      });
    }, delay);
    this.retryTimers.set(sourceServerId, timer);
  }

  private enterOfflineProbe(sourceServerId: string, error?: unknown): void {
    const input = this.reconnectInputs.get(sourceServerId);
    if (!input) return;
    const normalized = error === undefined ? undefined : normalizeRemoteConnectionError(error);
    if (normalized) {
      // Bug cause: the final cause after the recovery budget is exhausted stayed only in state.error, while the UI, per contract, does not display the raw Host
      // text, so diagnostic information had no stable outlet. The terminal state records only one warn per round and does not flush to disk on every probe heartbeat.
      this.options.logWarn?.(
        `[source-server] recovery budget exhausted source=${sourceServerId}`,
        error instanceof Error ? error : new Error(normalized.message),
      );
    }
    const errorCode =
      normalized?.code &&
      normalized.code !== "remote-connection-unknown" &&
      isPublicZCodeErrorCode(normalized.code)
        ? normalized.code
        : REMOTE_RECOVERY_BUDGET_EXHAUSTED_ERROR_CODE;
    for (const profileId of this.profileIdsForSource(sourceServerId, input.profile.profileId)) {
      this.setState(profileId, {
        state: "offline",
        sourceServerId,
        recoveryAttempt: ONLINE_RETRY_DELAYS_MS.length,
        recoveryLimit: ONLINE_RETRY_DELAYS_MS.length,
        recoveryBudgetExhausted: true,
        retryable: true,
        ...(normalized ? { error: normalized.message } : {}),
        ...(errorCode ? { errorCode } : {}),
      });
    }
    const existing = this.offlineProbeTimers.get(sourceServerId);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.offlineProbeTimers.delete(sourceServerId);
      void this.connectForSource(
        {
          profile: input.profile,
          target: input.target,
          context: input.context,
        },
        sourceServerId,
      ).catch((error) => {
        if (
          error instanceof SourceServerExplicitDisconnectError ||
          error instanceof SourceServerProfileRemovedError ||
          this.stopAutomaticRecoveryForTerminalFailure(sourceServerId, error)
        ) {
          return;
        }
        this.enterOfflineProbe(sourceServerId, error);
      });
    }, OFFLINE_PROBE_INTERVAL_MS);
    this.offlineProbeTimers.set(sourceServerId, timer);
  }

  private stopAutomaticRecoveryForTerminalFailure(sourceServerId: string, error: unknown): boolean {
    const input = this.reconnectInputs.get(sourceServerId);
    const ownerState = input ? this.states.get(input.profile.profileId) : undefined;
    const normalized = normalizeRemoteConnectionError(error);
    if (
      readErrorRetryable(error) !== false &&
      !isAutomaticRecoveryUserActionCode(normalized.code) &&
      !isSourceServerAutomaticRecoveryTerminalState(ownerState)
    ) {
      return false;
    }
    // Bug cause: the old recovery scheduling only recognized UpgradeRequired, so other user actions and retryable:false
    // would be overwritten by the next retry/offline probe. The terminal state must cut off the automatic path before creating subsequent timers.
    this.clearRecoveryTimers(sourceServerId);
    if (input && !isSourceServerAutomaticRecoveryTerminalState(ownerState)) {
      this.setState(input.profile.profileId, {
        state: "failed",
        sourceServerId,
        ...this.compatibilityByProfileId.get(input.profile.profileId),
        error: normalized.message,
        ...(isPublicZCodeErrorCode(normalized.code) ? { errorCode: normalized.code } : {}),
        retryable: false,
      });
    }
    if (input) {
      for (const profileId of this.profileIdsForSource(sourceServerId, input.profile.profileId)) {
        if (profileId === input.profile.profileId) continue;
        // Bug cause: after Source-level recovery stops, if a sibling Profile is left retrying, the aggregate state would still show
        // connecting while its logical wrapper never receives the terminal state. Only the real owner keeps an actionable pending state.
        this.setState(profileId, {
          state: "offline",
          sourceServerId,
          error: normalized.message,
          ...(isPublicZCodeErrorCode(normalized.code) ? { errorCode: normalized.code } : {}),
          retryable: false,
        });
      }
    }
    return true;
  }

  private profileIdsForSource(sourceServerId: string, fallbackProfileId: string): string[] {
    const remembered = this.profileIdsBySourceServerId.get(sourceServerId);
    return remembered && remembered.size > 0 ? [...remembered] : [fallbackProfileId];
  }

  private rememberSourceProfiles(sourceServerId: string, profileIds: Iterable<string>): void {
    const remembered = this.profileIdsBySourceServerId.get(sourceServerId) ?? new Set<string>();
    for (const profileId of profileIds) remembered.add(profileId);
    this.profileIdsBySourceServerId.set(sourceServerId, remembered);
  }

  private clearRecoveryTimers(sourceServerId: string): void {
    const retryTimer = this.retryTimers.get(sourceServerId);
    if (retryTimer) clearTimeout(retryTimer);
    this.retryTimers.delete(sourceServerId);
    const probeTimer = this.offlineProbeTimers.get(sourceServerId);
    if (probeTimer) clearTimeout(probeTimer);
    this.offlineProbeTimers.delete(sourceServerId);
  }

  private setState(
    profileId: string,
    patch: Omit<SourceServerConnectionStateSnapshot, "profileId" | "updatedAt">,
  ): void {
    const previous = this.states.get(profileId);
    const inheritedCompatibility =
      patch.state === "retrying" || patch.state === "offline" || patch.state === "updating"
        ? (this.compatibilityByProfileId.get(profileId) ??
          (previous ? preserveCompatibilityState(previous) : {}))
        : {};
    const snapshot: SourceServerConnectionStateSnapshot = {
      profileId,
      // Recovery, offline, and update are connection lifecycle states and produce no new version-compatibility fact; keep the last
      // Host handshake judgment, so the UI does not lose the current/available/minimum version fields during state transitions.
      ...inheritedCompatibility,
      ...patch,
      updatedAt: this.now(),
    };
    if (snapshot.currentVersion || snapshot.updateAvailability) {
      this.compatibilityByProfileId.set(profileId, preserveCompatibilityState(snapshot));
    }
    this.states.set(profileId, snapshot);
    if (previous?.state === "online" && snapshot.state !== "online" && previous.sourceServerId) {
      // The most recent online time is the last time it was online, not the handshake start time; a failed retry must not make an offline device look just online.
      void this.options.directory
        .recordLastOnline?.(previous.sourceServerId, snapshot.updatedAt)
        .catch((error: unknown) =>
          this.options.logWarn?.(
            "Failed to persist Source Server last online time",
            error instanceof Error ? error : new Error(String(error)),
          ),
        );
    }
    this.stateEmitter.fire(snapshot);
  }
}

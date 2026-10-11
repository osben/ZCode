import { SocketProtocol, ChannelClient, ChannelServer, type IServerChannel } from "@zcode/rpc";
import type { IServiceAccessor } from "@zcode/services";
import { RemoteServiceAccess } from "@zcode/client";
import {
  SERVICE_AUTHORITY_MODE_ENV,
  TOPIC_RESOURCE_RELAY_CHANNEL,
  ZCODE_APP_VERSION_ENV,
  ZCODE_DESKTOP_CONTEXT_PROMPT_ENABLED_ENV,
  ZCODE_DYNAMIC_WORKFLOW_MODE_ENV,
  formatLogPrefix,
  ZCODE_REMOTE_HTTP_PROXY_ENV_KEY,
  ZCODE_REMOTE_NO_PROXY_ENV_KEY,
  ZCODE_REMOTE_RUNTIME_NETWORK_AUTHORITY_ENV_KEY,
} from "@zcode/shared";
import type { IRemoteBackend } from "./backend.js";
import { wrapStdioStream } from "./stdio-socket.js";
import { performHandshake } from "./handshake.js";
import { deployServer } from "./deploy.js";
import type { DeployOptions } from "./deploy.js";
import { assertSupportedRemoteEnvironment } from "@zcode/server/remote/remotePlatformSupport.js";
import { quotePosixShellArg } from "./posixShell.js";
import { formatWslProxyForLog } from "./wslProxy.js";

const BACKEND_DISCONNECT_EXIT_CODE = -1;

export interface ConnectOptions extends DeployOptions {
  /** Private reverse resource channel over the current stdio, injected only by the Desktop Host. */
  topicResourceChannel?: IServerChannel;
  /** Client identifier for handshake */
  clientId?: string;
  /** Handshake timeout in ms (default: 10000) */
  handshakeTimeout?: number;
  /** Skip deploy step (assume server is already deployed) */
  skipDeploy?: boolean;
  /** Desktop app version, passed to the remote Agent so model-request headers can identify the client version. */
  appVersion?: string;
  /** Non-sensitive product environment variables for the remote server/Agent; callers may pass a broader env, which the server filters through an allowlist. */
  remoteRuntimeEnv?: Record<string, string | undefined>;
  /** Explicit Agent network configuration supplied by Desktop Host for a desktop-attached WSL server. */
  remoteRuntimeNetwork?: RemoteRuntimeNetworkOptions;
  /** Called when remote stdio closes so upper layers can detect disconnection and reclaim resources. */
  onDidRemoteClose?: (event: { code: number }) => void;
}

export interface RemoteRuntimeNetworkOptions {
  httpProxy?: string;
  noProxy?: string;
  /** Allow only Host to override older settings on the remote with an authoritative value. */
  authoritative?: boolean;
}

export interface RemoteConnection {
  services: IServiceAccessor;
  client: ChannelClient;
  dispose(): void;
  disposeAndWait(options?: { timeoutMs?: number }): Promise<void>;
}

const REMOTE_RUNTIME_ENV_KEYS = [
  "ZCODE_ENV",
  "ZCODE_BASE_URL",
  "ZCODE_ENDPOINT_ORIGIN",
  "ZCODE_TEST_BASE_URL",
  "ZCODE_PRODUCTION_BASE_URL",
  "ZAI_OAUTH_ORIGIN",
  "ZAI_TEST_OAUTH_ORIGIN",
  "ZAI_PRODUCTION_OAUTH_ORIGIN",
  "ZAI_BUSINESS_BASE_URL",
  "ZAI_TEST_BUSINESS_BASE_URL",
  "ZAI_PRODUCTION_BUSINESS_BASE_URL",
  "ZAI_OAUTH_CLIENT_ID",
  "ZAI_TEST_OAUTH_CLIENT_ID",
  "ZAI_PRODUCTION_OAUTH_CLIENT_ID",
  // Per-feature rollout decisions already computed by Desktop Main; the remote server consumes them without re-bucketing.
  ZCODE_DESKTOP_CONTEXT_PROMPT_ENABLED_ENV,
  // Likewise, Desktop Main sets the local override by build tier (buildHostProcessEnv). Passing it
  // through gives SSH/WSL/Docker remote Hosts the same tier as the local Host.
  ZCODE_DYNAMIC_WORKFLOW_MODE_ENV,
] as const;

export type RemoteRuntimeEnvKey = (typeof REMOTE_RUNTIME_ENV_KEYS)[number];
export type RemoteRuntimeEnv = Partial<Record<RemoteRuntimeEnvKey, string>>;

export function pickRemoteRuntimeEnv(env: Record<string, string | undefined>): RemoteRuntimeEnv {
  const picked: RemoteRuntimeEnv = {};
  for (const key of REMOTE_RUNTIME_ENV_KEYS) {
    const value = env[key]?.trim();
    if (value) {
      picked[key] = value;
    }
  }
  return picked;
}

function createRemoteConnectAbortError(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) {
    return signal.reason;
  }
  const error = new Error("Remote connection canceled");
  error.name = "AbortError";
  return error;
}

function throwIfRemoteConnectAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw createRemoteConnectAbortError(signal);
  }
}

/**
 * Connect to a remote zcode server via an IRemoteBackend.
 *
 * Steps:
 * 1. detect() → { platform, arch }
 * 2. Deploy if needed (upload node + server bundle + node-pty)
 * 3. exec server command
 * 4. Handshake (read hello, send ack)
 * 5. Wrap stdio → ISocket → SocketProtocol → ChannelClient → RemoteServiceAccess
 */
export async function connectRemote(
  backend: IRemoteBackend,
  options?: ConnectOptions,
): Promise<RemoteConnection> {
  const signal = options?.signal;
  let backendDisposed = false;
  const disposeBackendOnce = () => {
    if (backendDisposed) {
      return;
    }
    backendDisposed = true;
    backend.dispose();
  };
  if (signal?.aborted) {
    disposeBackendOnce();
    throw createRemoteConnectAbortError(signal);
  }

  let removeAbortListener: () => void = () => undefined;
  try {
    const connecting = connectRemoteUnchecked(backend, options);
    if (!signal) {
      return await connecting;
    }
    const aborted = new Promise<never>((_resolve, reject) => {
      const onAbort = () => {
        // After window Hosts were consolidated, connection cancellation could no longer kill a separate
        // SSH Host process. If this only ends the logical waiter, detect/deploy/upload continue using
        // old credentials and the connection. Since initialization has not been exposed yet, safely
        // release its exclusive backend and let the caller stop waiting immediately.
        disposeBackendOnce();
        reject(createRemoteConnectAbortError(signal));
      };
      signal.addEventListener("abort", onAbort, { once: true });
      removeAbortListener = () => signal.removeEventListener("abort", onAbort);
    });
    const guardedConnecting = connecting.then((connection) => {
      if (signal.aborted) {
        connection.dispose();
        throw createRemoteConnectAbortError(signal);
      }
      return connection;
    });
    return await Promise.race([guardedConnecting, aborted]);
  } catch (error) {
    // If detect/deploy/handshake fails, RemoteConnection has not been returned and the caller cannot
    // dispose the backend.
    disposeBackendOnce();
    throw error;
  } finally {
    removeAbortListener();
  }
}

async function connectRemoteUnchecked(
  backend: IRemoteBackend,
  options?: ConnectOptions,
): Promise<RemoteConnection> {
  const clientId = options?.clientId ?? `desktop-${Date.now()}`;

  const log = (...args: unknown[]) =>
    console.log(formatLogPrefix("connectRemote", process.pid), ...args);

  // 1. Detect remote environment
  log("detecting remote env...");
  const env = await backend.detect();
  throwIfRemoteConnectAborted(options?.signal);
  log("detected:", env);
  assertSupportedRemoteEnvironment(env);

  const remoteRuntimeNetwork = await resolveRemoteRuntimeNetwork(
    backend,
    options?.remoteRuntimeNetwork,
    log,
  );

  // 2. Deploy server if needed
  if (!options?.skipDeploy) {
    log("deploying server...");
    await deployServer(backend, env, options);
    throwIfRemoteConnectAborted(options?.signal);
    log("deploy complete");
  }

  // 3. Launch server
  log("launching remote server...");
  const stream = await backend.exec(buildRemoteServerCommand(options, remoteRuntimeNetwork));
  throwIfRemoteConnectAborted(options?.signal);
  log("remote server exec started");

  // Forward stderr for debugging
  stream.stderr.on("data", (chunk: Buffer) => {
    // Remote zcode-server service logs use stderr. Writing directly to host stderr can cause the
    // structured-log relay to swallow them. Forward them through the host console so remote SQLite
    // initialization and lock-conflict logs reliably appear in the connection-log panel and startup terminal.
    console.log(`[remote] ${chunk.toString().trimEnd()}`);
  });

  // 4. Handshake
  log("performing handshake...");
  const { hello, remaining } = await performHandshake(stream, clientId, options?.handshakeTimeout);
  throwIfRemoteConnectAborted(options?.signal);
  log("handshake done, server version:", hello.version);

  // 5. Wrap into RPC channel
  // If there's remaining data from handshake, push it back to the stream
  // so it gets picked up by wrapStdioStream's data listener
  if (remaining && remaining.length > 0) {
    (stream.stdout as NodeJS.ReadableStream & { unshift(chunk: Buffer): void }).unshift(remaining);
  }

  const socket = wrapStdioStream(stream);
  const protocol = new SocketProtocol(socket);
  const client = new ChannelClient(protocol);
  const reverseServer = options?.topicResourceChannel
    ? new ChannelServer(protocol, "desktop-resource")
    : undefined;
  if (reverseServer && options?.topicResourceChannel)
    reverseServer.registerChannel(TOPIC_RESOURCE_RELAY_CHANNEL, options.topicResourceChannel);
  const services = new RemoteServiceAccess(client);
  let hasReportedRemoteClose = false;
  let hasStreamClosed = false;
  let resolveStreamClosed!: () => void;
  const streamClosed = new Promise<void>((resolve) => {
    resolveStreamClosed = resolve;
  });
  const reportRemoteClose = (code: number) => {
    if (hasReportedRemoteClose) {
      return;
    }
    hasReportedRemoteClose = true;
    options?.onDidRemoteClose?.({ code });
  };

  const backendDisconnectDisposable = backend.onDidDisconnect?.((event) => {
    // When SSH keepalive detects a half-open connection, the remote server stdio channel may not close
    // immediately. Include backend disconnection in the same close-reporting path so host/main/UI can
    // reuse the existing session-close handling.
    const errorMessage = event.error?.message;
    log(
      errorMessage
        ? `remote backend disconnected: ${event.reason}: ${errorMessage}`
        : `remote backend disconnected: ${event.reason}`,
    );
    reportRemoteClose(BACKEND_DISCONNECT_EXIT_CODE);
  });
  const streamCloseDisposable = stream.onClose((code) => {
    hasStreamClosed = true;
    resolveStreamClosed();
    reportRemoteClose(code);
  });

  let disposalStarted = false;
  let backendDisposed = false;
  let disposeAndWaitInFlight: Promise<void> | null = null;
  const beginDisposal = () => {
    if (disposalStarted) {
      return;
    }
    disposalStarted = true;
    backendDisconnectDisposable?.dispose();
    reverseServer?.dispose();
    client.dispose();
    protocol.dispose();
    // Call stdin.end synchronously before any await so the remote stdio server receives EOF immediately.
    socket.dispose();
  };
  const disposeBackend = () => {
    if (backendDisposed) {
      return;
    }
    backendDisposed = true;
    streamCloseDisposable.dispose();
    backend.dispose();
  };
  const disposeBackendAndWait = async () => {
    if (backendDisposed) {
      return;
    }
    backendDisposed = true;
    streamCloseDisposable.dispose();
    if (backend.disposeAndWait) {
      await backend.disposeAndWait();
      return;
    }
    backend.dispose();
  };

  return {
    services,
    client,
    dispose() {
      beginDisposal();
      disposeBackend();
    },
    disposeAndWait(disposeOptions) {
      if (disposeAndWaitInFlight) {
        return disposeAndWaitInFlight;
      }
      beginDisposal();
      if (backendDisposed || hasStreamClosed) {
        disposeBackend();
        return Promise.resolve();
      }

      const timeoutMs = Math.max(disposeOptions?.timeoutMs ?? 5_000, 0);
      disposeAndWaitInFlight = (async () => {
        let timeout: ReturnType<typeof setTimeout> | undefined;
        const deadline = new Promise<"timed-out">((resolve) => {
          timeout = setTimeout(() => resolve("timed-out"), timeoutMs);
        });
        const result = await Promise.race([streamClosed.then(() => "closed" as const), deadline]);
        if (timeout) {
          clearTimeout(timeout);
        }
        if (result === "timed-out") {
          log(`remote stdio close timed out after ${timeoutMs}ms`);
        }
        await disposeBackendAndWait();
      })();
      return disposeAndWaitInFlight;
    },
  };
}

async function resolveRemoteRuntimeNetwork(
  backend: IRemoteBackend,
  network: RemoteRuntimeNetworkOptions | undefined,
  log: (...args: unknown[]) => void,
): Promise<RemoteRuntimeNetworkOptions | undefined> {
  if (!network || !backend.resolveRuntimeProxy) {
    // Apply this authoritative network configuration only to WSL backends that can resolve remote
    // proxies. SSH/Docker keep their existing launch commands even if options are passed by mistake.
    return undefined;
  }
  if (!network.httpProxy?.trim()) {
    return network;
  }

  try {
    const resolvedProxy = await backend.resolveRuntimeProxy(network.httpProxy);
    if (resolvedProxy !== network.httpProxy) {
      log(
        "resolved remote runtime proxy via wsl-host-gateway",
        formatWslProxyForLog(network.httpProxy),
        "->",
        formatWslProxyForLog(resolvedProxy),
      );
    }
    return { ...network, httpProxy: resolvedProxy };
  } catch (error) {
    // Proxy resolution is a runtime enhancement. On failure, keep the original Settings value so the
    // local WSL workspace does not become unreachable.
    log(
      "remote runtime proxy resolution failed; using configured endpoint",
      error instanceof Error ? error.message : String(error),
    );
    return network;
  }
}

function buildRemoteServerCommand(
  options: ConnectOptions | undefined,
  remoteRuntimeNetwork: RemoteRuntimeNetworkOptions | undefined,
): string {
  const envParts = [
    `${SERVICE_AUTHORITY_MODE_ENV}="desktop-attached-remote"`,
    'ZCODE_SERVER_RUNTIME_ROOT="$HOME/.zcode/server"',
  ];
  for (const [key, value] of Object.entries(
    pickRemoteRuntimeEnv(options?.remoteRuntimeEnv ?? {}),
  )) {
    envParts.push(`${key}=${quotePosixShellArg(value)}`);
  }
  const appVersion = options?.appVersion?.trim();
  if (appVersion) {
    // The remote server starts separately through SSH/WSL/Docker and does not inherit the desktop host
    // environment. Inject the app version into its process environment so the remote Agent can include
    // it in model-request headers.
    envParts.push(`${ZCODE_APP_VERSION_ENV}=${quotePosixShellArg(appVersion)}`);
  }
  if (remoteRuntimeNetwork?.authoritative) {
    envParts.push(`${ZCODE_REMOTE_RUNTIME_NETWORK_AUTHORITY_ENV_KEY}='1'`);
    if (remoteRuntimeNetwork.httpProxy !== undefined) {
      envParts.push(
        `${ZCODE_REMOTE_HTTP_PROXY_ENV_KEY}=${quotePosixShellArg(remoteRuntimeNetwork.httpProxy)}`,
      );
    }
    if (remoteRuntimeNetwork.noProxy !== undefined) {
      envParts.push(
        `${ZCODE_REMOTE_NO_PROXY_ENV_KEY}=${quotePosixShellArg(remoteRuntimeNetwork.noProxy)}`,
      );
    }
  }
  return `${envParts.join(" ")} ~/.zcode/server/node ~/.zcode/server/zcode-server.cjs`;
}

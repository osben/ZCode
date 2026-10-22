/**
 * ACP client wiring and handshake for one agent process: builds the client
 * app (permission, session/update and optional fs handlers) and runs
 * `initialize` (protocol version check) → `session/new` under per-step
 * deadlines. State commits stay with `AcpSessionRuntime`.
 */
import {
  PROTOCOL_VERSION,
  client as createClientApp,
  methods,
  type ClientCapabilities,
  type ClientConnection,
  type InitializeResponse,
  type NewSessionResponse,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionNotification,
} from "@agentclientprotocol/sdk";
import { AcpProtocolVersionError } from "./errors.js";
import { readTextFileViaBridge, writeTextFileViaBridge } from "./fs.js";
import { buildChildEnv } from "./launch.js";
import { withTimeout } from "./runtime-helpers.js";
import { spawnAcpProcess, type SpawnedAcpProcess } from "./transport.js";
import type { AcpFrameObserver, AcpFsBridge, AcpLaunchOptions } from "./types.js";

/** Spawns a validated launch with the scrubbed child env (spec: shared `buildChildEnv`). */
export function spawnAcpAgentProcess(
  launch: AcpLaunchOptions,
  options: {
    readonly maxFrameBytes?: number;
    readonly onFrame?: AcpFrameObserver;
    readonly onInboundActivity: () => void;
  },
): SpawnedAcpProcess {
  return spawnAcpProcess({
    command: launch.command,
    args: launch.args,
    cwd: launch.cwd,
    env: buildChildEnv(process.env, launch.env),
    ...(options.maxFrameBytes !== undefined ? { maxFrameBytes: options.maxFrameBytes } : {}),
    ...(options.onFrame !== undefined ? { onFrame: options.onFrame } : {}),
    onInboundActivity: options.onInboundActivity,
  });
}

/** Races a handshake step against the process's spawn and stream failures. */
export function raceProcessFailures<T>(
  proc: SpawnedAcpProcess | undefined,
  operation: Promise<T>,
): Promise<T> {
  if (!proc) return operation;
  return Promise.race([operation, proc.spawnFailure, proc.streamFailure]);
}

export interface AcpClientHandlers {
  readonly agentId: string;
  readonly fs: AcpFsBridge | undefined;
  readonly onPermission: (request: RequestPermissionRequest) => Promise<RequestPermissionResponse>;
  readonly onUpdate: (notification: SessionNotification) => void;
}

/** Connects the ACP client app to the process stream; fs capabilities follow the bridge. */
export function connectAcpClient(
  proc: SpawnedAcpProcess,
  handlers: AcpClientHandlers,
): { connection: ClientConnection; capabilities: ClientCapabilities } {
  const app = createClientApp({ name: `zcode-acp-agent-runtime (${handlers.agentId})` })
    .onRequest(methods.client.session.requestPermission, (ctx) => handlers.onPermission(ctx.params))
    .onNotification(methods.client.session.update, (ctx) => handlers.onUpdate(ctx.params));
  const fsBridge = handlers.fs;
  if (fsBridge) {
    app.onRequest(methods.client.fs.readTextFile, (ctx) =>
      readTextFileViaBridge(fsBridge, ctx.params),
    );
    app.onRequest(methods.client.fs.writeTextFile, (ctx) =>
      writeTextFileViaBridge(fsBridge, ctx.params),
    );
  }
  const capabilities: ClientCapabilities = fsBridge
    ? { fs: { readTextFile: true, writeTextFile: true } }
    : {};
  return { connection: app.connect(proc.stream), capabilities };
}

export interface AcpHandshakeOptions {
  readonly cwd: string;
  readonly capabilities: ClientCapabilities;
  readonly initializeMs: number;
  readonly newSessionMs: number;
  /** Races each step against the owning process's spawn and stream failures. */
  readonly race: <T>(operation: Promise<T>) => Promise<T>;
  /** Runs after a version-checked `initialize`, before `session/new`. */
  readonly onInitialized: (init: InitializeResponse) => void;
}

export async function performAcpHandshake(
  connection: ClientConnection,
  options: AcpHandshakeOptions,
): Promise<NewSessionResponse> {
  const init = await options.race(
    withTimeout(
      connection.agent.request(methods.agent.initialize, {
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: options.capabilities,
      }),
      options.initializeMs,
      "initialize",
    ),
  );
  if (init.protocolVersion !== PROTOCOL_VERSION) {
    throw new AcpProtocolVersionError(PROTOCOL_VERSION, init.protocolVersion);
  }
  options.onInitialized(init);
  return options.race(
    withTimeout(
      connection.agent.request(methods.agent.session.new, { cwd: options.cwd, mcpServers: [] }),
      options.newSessionMs,
      "session/new",
    ),
  );
}

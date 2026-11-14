import { join } from "node:path";
import { createMcpAdapterConnectionPool } from "@zcode/adapters/mcp";
import { createNodePluginAdapter } from "@zcode/adapters/plugins";
import { createConfig, resolvePath } from "@zcode/adapters/config";
import { createNodeLoggerFactory } from "@zcode/adapters/logging";
import {
  createInMemorySessionEventStore,
  createNodeToolArtifactStore,
  createSqliteSessionStore,
  type SqliteSessionStore,
} from "@zcode/adapters/storage";
import { InMemoryWorkspaceHookPolicyProvider } from "@zcode/core";
import type { ZCodeProtocolMessage } from "@zcode/shared";
import type { JournalStorePort } from "@zcode/dynamic-workflow";
import { createOfficialPluginPreparation } from "../app/bundled-plugins.js";
import { resolveDynamicWorkflowJournalStore } from "../app/dynamic-workflow-run-journal.js";
import { resolveMcpNodeFallbackProvider } from "../app/mcp-node-fallback.js";
import { resolveZCodePlugins } from "../plugins.js";
import { getCliStorageRoot, getPluginStorageRoot } from "../app/paths.js";
import { getSessionDbPath } from "../app/session-store.js";
import { ZCodeProtocolNdjsonConnection } from "../zcode-protocol/transport.js";
import type { ZCodeProtocolAgentServerContext } from "../zcode-protocol/server-types.js";
import { V4InteractionRegistry } from "../zcode-protocol-v4/interaction-registry.js";
import { FORK_RUST_HELPER_F3 } from "./f3-protocol.js";
import { ForkRustHelperMcpHost } from "./mcp-host.js";
import { ForkRustHelperClient } from "./rust-client.js";
import { ForkRustHelperServer } from "./server.js";
import { createWorkflowRunReads } from "./workflow-run-reads.js";

export interface RunForkRustHelperOptions {
  input: NodeJS.ReadableStream;
  output: NodeJS.WritableStream;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  /** The CLI process lifecycle: an abort (signal, stdout closed) closes the connection like stdin EOF. */
  signal?: AbortSignal;
}

/**
 * F3 traffic that must not wait behind a queued request (spec "Helper connection"): MCP pipe
 * messages, helper sessions, app-tool calls and their cancels, and answers to the helper's own
 * requests (a queued mention request waits for its authorization answer).
 */
const CONCURRENT_METHODS: ReadonlySet<string> = new Set([
  FORK_RUST_HELPER_F3.mcpConnect,
  FORK_RUST_HELPER_F3.mcpSend,
  FORK_RUST_HELPER_F3.mcpClose,
  FORK_RUST_HELPER_F3.sessionOpen,
  FORK_RUST_HELPER_F3.sessionClose,
  FORK_RUST_HELPER_F3.appToolsCall,
  FORK_RUST_HELPER_F3.appToolsCancel,
]);

function isConcurrent(message: ZCodeProtocolMessage): boolean {
  return "method" in message ? CONCURRENT_METHODS.has(message.method) : true;
}

function refuseSessions(): never {
  // Rule 2 of specs/fork-rust-node-helper.md: conversations belong to the Rust agent.
  throw new Error("The Rust agent's Node helper never opens a conversation");
}

/**
 * `__zcode-rust-helper --stdio`: the Node helper of the Rust agent (specs/fork-rust-node-helper.md).
 *
 * The helper resolves its storage the way a Node agent started with the same env does, so both
 * runtimes address the same plugin store and session database. It runs no storage preparation: the
 * Host Worker prepared the database before the Rust agent started, and opening the store only runs
 * Node's idempotent migration check. Resolves when the Rust agent closes stdin.
 */
export async function runForkRustHelper(options: RunForkRustHelperOptions): Promise<void> {
  const env = options.env ?? process.env;
  const configResult = createConfig({ env });
  const storageRoot = resolvePath(configResult.config.storage.dir);
  const loggerFactory = createNodeLoggerFactory({ env });
  const logger = loggerFactory.createLogger("zcode").child({ module: "bootstrap.fork_rust_helper" });
  const pluginPreparation = createOfficialPluginPreparation();
  const pluginDiscovery = createNodePluginAdapter({
    storageRoot: getPluginStorageRoot(getCliStorageRoot(storageRoot)),
  });

  let connection: ZCodeProtocolNdjsonConnection | undefined;
  let sessionStore: Promise<SqliteSessionStore> | undefined;
  const send = (message: unknown) => connection?.send(message as never);
  const client = new ForkRustHelperClient(send);
  let mcpHost: ForkRustHelperMcpHost | undefined;
  const pool = createMcpAdapterConnectionPool({
    // Elicitation from a helper-hosted server is declined: the helper has no Host client (spec F3).
    elicitation: { requestElicitation: () => Promise.resolve({ action: "decline" as const }) },
    notifications: { onNotification: (notification) => mcpHost?.handleNotification(notification) },
    clientVersion: env.ZCODE_APP_VERSION?.trim() || "0.0.0",
    env,
    logger,
    network: {
      httpProxy: configResult.config.network.httpProxy,
      noProxy: configResult.config.network.noProxy,
      caCertFile: configResult.config.network.caCertFile,
    },
    nodeFallback: resolveMcpNodeFallbackProvider({
      cliStorageRoot: getCliStorageRoot(storageRoot),
      logger,
    }),
    ...(options.cwd === undefined ? {} : { workingDirectory: options.cwd }),
  });
  const context: ZCodeProtocolAgentServerContext = {
    deps: {
      createZCodeApp: refuseSessions,
      createSessionEventStore: () => createInMemorySessionEventStore(),
      workspaceHookPolicyProvider: new InMemoryWorkspaceHookPolicyProvider(),
      pluginPreparation,
      pluginDiscovery,
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      env,
      loggerFactory,
      storageRoot,
    },
    logger,
    appRuntimePreferences: {
      askUserQuestionAutoResolutionEnabled: true,
      modelIoFullRetentionEnabled: false,
      offPeakToolEnabled: false,
      dynamicWorkflowEnabled: false,
    },
    notify: (notification) => connection?.send(notification),
    requestClient: () => Promise.reject(new Error("The Rust agent's Node helper has no Host client")),
    sessions: new Map(),
    v4Interactions: new V4InteractionRegistry(),
    // F3: the helper's sessions are opened by Rust and are ready while present; nothing activates.
    sessionLifecycle: {
      isReady: () => true,
      ensureReady: () => Promise.resolve(),
    } as unknown as ZCodeProtocolAgentServerContext["sessionLifecycle"],
    // F3: the four plugin UI events go to Rust as live-only session deltas.
    v4Gateway: {
      ingest: (sessionId: string, event: Parameters<ForkRustHelperMcpHost["ingest"]>[1]) =>
        mcpHost?.ingest(sessionId, event),
    } as unknown as ZCodeProtocolAgentServerContext["v4Gateway"],
  };
  mcpHost = new ForkRustHelperMcpHost({
    context,
    client,
    notify: (method, params) => send({ method, params }),
    pool,
    resolvePlugins: (workspace) =>
      resolveZCodePlugins({
        pluginPreparation,
        pluginDiscovery,
        logger,
        workingDirectory: workspace.workspacePath,
        ...(workspace.workspaceIdentity ? { workspaceIdentity: workspace.workspaceIdentity } : {}),
        env,
      }),
    logger,
  });

  const openSessionStore = () => {
    sessionStore ??= createSqliteSessionStore({ dbPath: getSessionDbPath(configResult, options.cwd) }).then(
      (store) => {
        context.deps.sessionStore = store;
        return store;
      },
      (error: unknown) => {
        sessionStore = undefined;
        throw error;
      },
    );
    return sessionStore;
  };

  // Resolved once per opened store, as Node does when it builds the run service (it logs when absent).
  let journal: { store: SqliteSessionStore; port: JournalStorePort | undefined } | undefined;
  const openJournal = async () => {
    const store = await openSessionStore();
    if (journal?.store !== store)
      journal = { store, port: resolveDynamicWorkflowJournalStore(store, logger) };
    return journal.port;
  };

  const server = new ForkRustHelperServer({
    client,
    mcpHost,
    logger,
    context,
    ensureSessionStore: async () => {
      await openSessionStore();
    },
    workflowRuns: createWorkflowRunReads({
      journal: openJournal,
      logger,
      artifactStore: createNodeToolArtifactStore({
        imageCacheRootDir: join(storageRoot, "cli", "image-cache"),
        pdfCacheRootDir: join(storageRoot, "cli", "pdf-cache"),
        rootDir: join(storageRoot, "cli", "artifacts"),
        videoCacheRootDir: join(storageRoot, "cli", "video-cache"),
      }),
    }),
  });

  connection = new ZCodeProtocolNdjsonConnection({
    handleMessage: (message: ZCodeProtocolMessage) => server.handleMessage(message),
    input: options.input,
    isConcurrent,
    logger,
    onTransportClosed: (error) => {
      server.abortAll(error);
      client.close(error);
    },
    output: options.output,
    ...(options.signal ? { signal: options.signal } : {}),
  });
  logger.info("Rust agent Node helper started", { event: "fork_rust_helper.started" });
  connection.start();
  try {
    await connection.waitForClose();
  } finally {
    client.close(new Error("The Rust agent closed the helper"));
    await mcpHost.dispose().catch(() => undefined);
    await pool.close().catch(() => undefined);
    pluginDiscovery.dispose();
    await pluginPreparation.dispose();
    if (sessionStore) (await sessionStore.catch(() => undefined))?.close();
    logger.info("Rust agent Node helper stopped", { event: "fork_rust_helper.stopped" });
  }
}

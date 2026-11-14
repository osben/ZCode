import type { McpConnectionPool } from "@zcode/adapters/mcp";
import {
  createRootTraceContext,
  McpResourceSubscribeUnsupportedError,
  resolveMcpToolVisibility,
  SessionEventType,
  type Logger,
  type McpPort,
  type McpServerConfig,
  type McpServerNotification,
  type McpToolCallResult,
  type PluginLoadOutcome,
  type SessionEvent,
  type SessionId,
  type TraceContext,
} from "@zcode/contracts";
import {
  buildPluginReferenceCatalog,
  type McpAppProvidedToolDefinition,
  type McpAppProvidedToolExecutor,
} from "@zcode/core";
import type { ZCodeApp } from "../app/types.js";
import {
  abortMcpUiToolCallsForSession,
  clearMcpUiAppToolsForSession,
} from "../zcode-protocol/mcp-ui/index.js";
import {
  ProtocolRequestError,
  type ZCodeProtocolAgentServerContext,
  type ZCodeProtocolSessionRecord,
} from "../zcode-protocol/server-types.js";
import {
  errorMessage,
  FORK_RUST_HELPER_F3,
  parseWorkspace,
  requireOpenId,
  requireString,
  toPluginUiDelta,
  toWireResult,
  workspaceKeyOf,
  type HelperWorkspace,
} from "./f3-protocol.js";
import type { ForkRustHelperClient } from "./rust-client.js";
import { SessionLanes } from "./session-lanes.js";
import { createHelperSessionRecord, type HelperSession } from "./session-record.js";

interface JsonRpcMessage {
  jsonrpc?: "2.0";
  id?: string | number;
  method?: string;
  params?: Record<string, unknown>;
}

interface HelperContextMeta {
  sessionId: string;
  turnId?: string;
  runtimeScope?: "main" | "subagent";
}

interface PipeConnection {
  server: string;
  port: McpPort;
  inflight: Map<string | number, AbortController>;
  offInvalidated: () => void;
}

export interface ForkRustHelperMcpHostDeps {
  context: ZCodeProtocolAgentServerContext;
  client: ForkRustHelperClient;
  /** One notification to the Rust agent. */
  notify(method: string, params: Record<string, unknown>): void;
  pool: McpConnectionPool;
  resolvePlugins(workspace: HelperWorkspace): Promise<PluginLoadOutcome>;
  logger?: Logger;
}

const SESSION_NOT_OPEN = -32602;

/**
 * The helper's MCP side for F3: Rust's MCP client pipes (a small MCP server facade over Node's MCP
 * pool) and the helper sessions behind the forwarded `mcp/ui*` and `plugins/mentionItems` methods.
 * Server configuration comes only from the helper's own plugin resolution, so a pipe and a panel
 * reach the same pool entry.
 */
export class ForkRustHelperMcpHost {
  /**
   * Plugin resolutions by workspace and directory: one Rust agent may serve several workspaces, and an
   * execution worktree session resolves in its worktree (spec F3 pipe messages, session open).
   */
  private readonly plugins = new Map<string, Promise<PluginLoadOutcome>>();
  private readonly pipes = new Map<string, PipeConnection>();
  /** Pipe connects in flight; `true` once Rust closed the connection meanwhile (spec F3 pipe messages). */
  private readonly connecting = new Map<string, boolean>();
  private readonly sessions = new Map<string, HelperSession>();
  private readonly lanes = new SessionLanes();

  constructor(private readonly deps: ForkRustHelperMcpHostDeps) {}

  /** True while a pipe connection or a session keeps resources open. */
  get busy(): boolean {
    return this.pipes.size > 0 || this.sessions.size > 0;
  }

  // ── Plugin resolution and workspace ──

  private outcome(workspace: HelperWorkspace): Promise<PluginLoadOutcome> {
    const key = JSON.stringify([workspace.workspaceIdentity ?? null, workspace.workspacePath]);
    let outcome = this.plugins.get(key);
    if (!outcome) {
      outcome = this.deps.resolvePlugins(workspace).catch((error: unknown) => {
        if (this.plugins.get(key) === outcome) this.plugins.delete(key);
        throw error;
      });
      this.plugins.set(key, outcome);
    }
    return outcome;
  }

  private async serverConfig(server: string, workspace: HelperWorkspace): Promise<McpServerConfig> {
    const config = (await this.outcome(workspace)).mcpServers[server];
    if (!config) throw new ProtocolRequestError(-32602, `MCP server is not a helper plugin server: ${server}`);
    return config;
  }

  /** `directory` is where the servers run: the workspace, or a session's execution worktree. */
  private connectOptions(workspace: HelperWorkspace, directory = workspace.workspacePath) {
    return {
      workingDirectory: directory,
      ...(workspace.workspaceIdentity ? { workspaceIdentity: workspace.workspaceIdentity } : {}),
      workspaceKey: workspaceKeyOf(workspace),
    };
  }

  // ── Pipe connections ──

  async connect(params: Record<string, unknown> | undefined): Promise<Record<string, never>> {
    const connection = requireString(params, "connection");
    const server = requireString(params, "server");
    if (this.pipes.has(connection) || this.connecting.has(connection))
      throw new ProtocolRequestError(-32602, `Connection already open: ${connection}`);
    this.connecting.set(connection, false);
    try {
      return await this.connectPipe(connection, server, parseWorkspace(params?.workspace));
    } finally {
      this.connecting.delete(connection);
    }
  }

  /** Rust gave up on this connect and closed it: a late connect must not keep its lease and MCP child. */
  private assertStillWanted(connection: string): void {
    if (this.connecting.get(connection)) throw new Error(`Connection closed while connecting: ${connection}`);
  }

  private async connectPipe(
    connection: string,
    server: string,
    workspace: HelperWorkspace,
  ): Promise<Record<string, never>> {
    const config = await this.serverConfig(server, workspace);
    this.assertStillWanted(connection);
    const port = this.deps.pool.acquireLease({ leaseId: `fork-rust-pipe:${connection}` });
    try {
      const status = await port.connectServer(server, config, this.connectOptions(workspace));
      if (status.status !== "connected")
        throw new Error(status.error ?? `MCP server ${server} is ${status.status}`);
      this.assertStillWanted(connection);
    } catch (error) {
      await port.close().catch(() => undefined);
      throw error;
    }
    const pipe: PipeConnection = {
      server,
      port,
      inflight: new Map(),
      offInvalidated: () => {},
    };
    pipe.offInvalidated =
      port.onAppConnectionInvalidated?.(server, () => {
        if (this.pipes.get(connection) !== pipe) return;
        this.deps.notify(FORK_RUST_HELPER_F3.mcpClosed, { connection, reason: "connection closed" });
        void this.closePipe(connection);
      }) ?? (() => {});
    this.pipes.set(connection, pipe);
    return {};
  }

  async closePipe(connection: string): Promise<void> {
    const pipe = this.pipes.get(connection);
    if (!pipe) {
      if (this.connecting.has(connection)) this.connecting.set(connection, true);
      return;
    }
    this.pipes.delete(connection);
    pipe.offInvalidated();
    for (const controller of pipe.inflight.values()) controller.abort(new Error("Connection closed"));
    await pipe.port.close().catch((error: unknown) =>
      this.deps.logger?.warn("Rust pipe MCP lease close failed", {
        event: "fork_rust_helper.mcp_pipe.close_failed",
        error: errorMessage(error),
      }),
    );
  }

  /** One MCP message from Rust's client. Answers go back as `helper/mcp/message`. */
  async send(params: Record<string, unknown> | undefined): Promise<void> {
    const connection = typeof params?.connection === "string" ? params.connection : "";
    const message = (params?.message ?? {}) as JsonRpcMessage;
    const pipe = this.pipes.get(connection);
    if (message.id === undefined) {
      if (message.method === "notifications/cancelled") {
        const requestId = (message.params as { requestId?: string | number } | undefined)?.requestId;
        if (requestId !== undefined) pipe?.inflight.get(requestId)?.abort(new Error("Request cancelled"));
      }
      return;
    }
    const answer = (body: { result: unknown } | { error: { code: number; message: string } }) =>
      this.deps.notify(FORK_RUST_HELPER_F3.mcpMessage, {
        connection,
        message: { jsonrpc: "2.0", id: message.id, ...body },
      });
    if (!pipe) {
      answer({ error: { code: -32000, message: `Connection is not open: ${connection}` } });
      return;
    }
    const controller = new AbortController();
    pipe.inflight.set(message.id, controller);
    try {
      answer({ result: await this.answerMcp(pipe, message, controller.signal) });
    } catch (error) {
      const code =
        error instanceof ProtocolRequestError
          ? error.code
          : controller.signal.aborted
            ? -32800
            : -32603;
      answer({ error: { code, message: errorMessage(error) } });
    } finally {
      pipe.inflight.delete(message.id);
    }
  }

  private async answerMcp(pipe: PipeConnection, message: JsonRpcMessage, signal: AbortSignal) {
    switch (message.method) {
      case "initialize":
        return {
          protocolVersion: message.params?.protocolVersion ?? "2025-06-18",
          capabilities: { tools: { listChanged: true } },
          serverInfo: { name: pipe.server, version: "1.0.0" },
        };
      case "ping":
        return {};
      case "tools/list":
        return { tools: await this.listModelTools(pipe) };
      case "tools/call":
        return toWireResult(await this.callModelTool(pipe, message.params ?? {}, signal));
      default:
        throw new ProtocolRequestError(-32601, `Method not found: ${String(message.method)}`);
    }
  }

  private async listModelTools(pipe: PipeConnection) {
    const tools = await pipe.port.listTools();
    return tools
      .filter((tool) => tool.serverName === pipe.server && resolveMcpToolVisibility(tool).includes("model"))
      .map((tool) => ({
        name: tool.toolName,
        ...(tool.description !== undefined ? { description: tool.description } : {}),
        inputSchema: tool.inputSchema,
        ...(tool.annotations !== undefined ? { annotations: tool.annotations } : {}),
        ...(tool.alwaysLoad ? { _meta: { "zcode/alwaysLoad": true } } : {}),
      }));
  }

  /** A model tool call runs on the session's lease, with the fields Node's MCP tool entry sends. */
  private async callModelTool(
    pipe: PipeConnection,
    params: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<McpToolCallResult> {
    const meta = (params._meta ?? {}) as Record<string, unknown>;
    const helperContext = meta["zcode/helperContext"] as HelperContextMeta | undefined;
    const sessionId = helperContext?.sessionId;
    const session = sessionId ? this.sessions.get(sessionId) : undefined;
    if (!session)
      throw new ProtocolRequestError(
        SESSION_NOT_OPEN,
        `Session is not open in the Node helper: ${String(sessionId)}`,
      );
    const workspace = session.workspace;
    const turnId = helperContext?.turnId;
    return session.port.callTool(
      {
        serverName: pipe.server,
        toolName: requireString(params, "name"),
        arguments: (params.arguments ?? {}) as Record<string, unknown>,
        trace: {
          ...session.traceContext,
          ...(turnId ? { turnId: turnId as never } : {}),
        },
        runtimeScope: helperContext?.runtimeScope ?? "main",
        // Node's MCP tool entry: the working directory, and the session's workspace key.
        workspacePath: session.directory,
        ...(workspace.workspaceIdentity ? { workspaceIdentity: workspace.workspaceIdentity } : {}),
        workspaceKey: workspaceKeyOf(workspace),
        ...(turnId ? { turnId } : {}),
        clientMode: "desktop-continuous",
        deliveryKind: "desktop-continuous",
      },
      { signal },
    );
  }

  /** Node's pool notifications: the real server's tool list change reaches every pipe of it. */
  handleNotification(notification: McpServerNotification): void {
    if (notification.kind !== "toolListChanged") return;
    for (const [connection, pipe] of this.pipes) {
      if (pipe.server !== notification.serverName) continue;
      this.deps.notify(FORK_RUST_HELPER_F3.mcpMessage, {
        connection,
        message: { jsonrpc: "2.0", method: "notifications/tools/list_changed" },
      });
    }
  }

  // ── Sessions ──

  /** An open of a session that is open replaces it: the old one is closed, the new params apply. */
  async openSession(params: Record<string, unknown> | undefined): Promise<Record<string, never>> {
    const sessionId = requireString(params, "sessionId");
    const openId = requireOpenId(params);
    await this.lanes.run(sessionId, async () => {
      if (this.sessions.has(sessionId)) await this.endSession(sessionId);
      await this.doOpenSession(sessionId, openId, params ?? {});
    });
    return {};
  }

  private async doOpenSession(
    sessionId: string,
    openId: number,
    params: Record<string, unknown>,
  ): Promise<void> {
    const workspace = parseWorkspace(params.workspace);
    // Node's app runs in the execution worktree unless it is missing (create-app.ts:200-208); Rust
    // sends it only when it exists.
    const directory =
      typeof params.executionDirectory === "string" && params.executionDirectory
        ? params.executionDirectory
        : workspace.workspacePath;
    const outcome = await this.outcome({ ...workspace, workspacePath: directory });
    const admitted = new Set(Array.isArray(params.pluginIds) ? (params.pluginIds as string[]) : []);
    const requested = Array.isArray(params.servers) ? (params.servers as string[]) : [];
    const servers: Record<string, McpServerConfig> = {};
    for (const name of requested) {
      const config = outcome.mcpServers[name];
      if (config) servers[name] = config;
      else
        this.deps.logger?.warn("Rust session names a server the helper did not resolve", {
          event: "fork_rust_helper.session.unknown_server",
          mcpServerName: name,
        });
    }
    const rootSessionId = typeof params.rootSessionId === "string" ? params.rootSessionId : undefined;
    // A subagent's calls carry its root session, as Node's child runtime does (adapter `root_session_id`).
    const traceContext: TraceContext = {
      ...createRootTraceContext({ sessionId: sessionId as SessionId }),
      ...(rootSessionId && rootSessionId !== sessionId
        ? { rootSessionId: rootSessionId as SessionId }
        : {}),
    };
    const port = this.deps.pool.acquireLease({ leaseId: sessionId, sessionId });
    try {
      const snapshot = await port.connectConfiguredServers(servers, {
        ...this.connectOptions(workspace, directory),
        trace: traceContext,
      });
      for (const [name, status] of Object.entries(snapshot.statuses))
        if (status.status !== "connected")
          this.deps.logger?.warn("Helper session MCP server did not connect", {
            event: "fork_rust_helper.session.server_failed",
            mcpServerName: name,
            mcpServerStatus: status.status,
            ...(status.error ? { error: status.error } : {}),
          });
      // The catalog Rust's admission agrees with: a plugin Rust did not admit is listed, not referenceable.
      const catalog = buildPluginReferenceCatalog(
        outcome.plugins.map((plugin) => {
          const enabled = plugin.enabled && admitted.has(plugin.id);
          return enabled ? plugin : { ...plugin, enabled: false, mcpServerNames: [] };
        }),
      );
      const session: HelperSession = {
        sessionId,
        openId,
        workspace,
        directory,
        port,
        catalog,
        traceContext,
        appTools: new Map(),
        appToolCalls: new Map(),
      };
      this.deps.context.sessions.set(
        sessionId,
        createHelperSessionRecord(session, { client: this.deps.client, logger: this.deps.logger }),
      );
      this.sessions.set(sessionId, session);
    } catch (error) {
      // Nothing owns the lease of a failed open: Rust keeps no session for it.
      await port.close().catch(() => undefined);
      throw error;
    }
  }

  /** Rust's close of one open: a close of an earlier open of the session is ignored. */
  async closeSession(params: Record<string, unknown> | undefined): Promise<void> {
    const sessionId = typeof params?.sessionId === "string" ? params.sessionId : "";
    const openId = params?.openId;
    await this.lanes.run(sessionId, async () => {
      if (this.sessions.get(sessionId)?.openId === openId) await this.endSession(sessionId);
    });
  }

  /** Node's close steps for a session (session-residency.ts), then the lease. */
  private async endSession(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    this.sessions.delete(sessionId);
    this.deps.context.sessions.delete(sessionId);
    abortMcpUiToolCallsForSession(sessionId);
    clearMcpUiAppToolsForSession(this.deps.context, sessionId);
    for (const controller of session.appToolCalls.values())
      controller.abort(new Error("Session closed"));
    try {
      await session.port.unsubscribeResourcesBySubscriber?.(`${sessionId}|`);
    } catch (error) {
      this.deps.logger?.warn("Helper session resource unsubscribe failed", {
        event: "fork_rust_helper.session.unsubscribe_failed",
        error: errorMessage(error),
      });
    }
    await session.port.close().catch(() => undefined);
  }

  // ── App-provided tools (Rust → helper) ──

  async callAppTool(params: Record<string, unknown> | undefined) {
    const sessionId = requireString(params, "sessionId");
    const toolCallId = requireString(params, "toolCallId");
    const name = requireString(params, "name");
    const session = this.sessions.get(sessionId);
    const tool = session?.appTools.get(name);
    if (!session || !tool) throw new ProtocolRequestError(-32602, `App tool is not registered: ${name}`);
    const controller = new AbortController();
    session.appToolCalls.set(toolCallId, controller);
    const retained = tool.definition.retainExecution?.(toolCallId);
    const signal = retained ? AbortSignal.any([controller.signal, retained.signal]) : controller.signal;
    try {
      const input = params?.input;
      return toWireResult(
        await tool.execute(
          {
            definition: tool.definition,
            arguments: input && typeof input === "object" && !Array.isArray(input)
              ? (input as Record<string, unknown>)
              : {},
            toolCallId,
          },
          { signal },
        ),
      );
    } finally {
      retained?.release();
      session.appToolCalls.delete(toolCallId);
    }
  }

  cancelAppTool(params: Record<string, unknown> | undefined): void {
    const sessionId = typeof params?.sessionId === "string" ? params.sessionId : "";
    const toolCallId = typeof params?.toolCallId === "string" ? params.toolCallId : "";
    this.sessions.get(sessionId)?.appToolCalls.get(toolCallId)?.abort(new Error("Tool call cancelled"));
  }

  /** The helper's stand-in for Node's v4 gateway: the four plugin UI events become live-only deltas. */
  ingest(sessionId: string, event: SessionEvent): void {
    const delta = toPluginUiDelta(event);
    if (delta) this.deps.notify(FORK_RUST_HELPER_F3.sessionDelta, { sessionId, delta });
  }

  async dispose(): Promise<void> {
    for (const connection of [...this.pipes.keys()]) await this.closePipe(connection);
    for (const sessionId of [...this.sessions.keys()])
      await this.lanes.run(sessionId, () => this.endSession(sessionId));
  }

}

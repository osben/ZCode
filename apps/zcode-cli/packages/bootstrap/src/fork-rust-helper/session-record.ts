import {
  McpResourceSubscribeUnsupportedError,
  resolveMcpToolVisibility,
  type Logger,
  type McpPort,
  type TraceContext,
} from "@zcode/contracts";
import type {
  buildPluginReferenceCatalog,
  McpAppProvidedToolDefinition,
  McpAppProvidedToolExecutor,
} from "@zcode/core";
import type { ZCodeApp } from "../app/types.js";
import type { ZCodeProtocolSessionRecord } from "../zcode-protocol/server-types.js";
import {
  errorMessage,
  FORK_RUST_HELPER_F3,
  type HelperWorkspace,
} from "./f3-protocol.js";
import { toNodeError, type ForkRustHelperClient } from "./rust-client.js";

/** One helper session: a Rust session opened in this helper generation (spec F3 "Session open and close"). */
export interface HelperSession {
  sessionId: string;
  /** The open that made it: Rust's close names it, so a stale close never ends a reopen. */
  openId: number;
  /** The workspace its open named, the session's own (never the Rust agent's cwd): its key. */
  workspace: HelperWorkspace;
  /** Where it runs: its execution worktree, else the workspace path (Node create-app.ts:200-208). */
  directory: string;
  port: McpPort;
  catalog: ReturnType<typeof buildPluginReferenceCatalog>;
  traceContext: TraceContext;
  appTools: Map<string, { definition: McpAppProvidedToolDefinition; execute: McpAppProvidedToolExecutor }>;
  appToolCalls: Map<string, AbortController>;
}

export interface HelperSessionRecordDeps {
  client: ForkRustHelperClient;
  logger?: Logger;
}

/**
 * The session record Node's mcp-ui and mention handlers read: the parts of a ZCodeApp they call, on
 * the session's MCP lease. Authorization, sampling and app-provided tools go to the Rust agent.
 */

export function createHelperSessionRecord(
session: HelperSession,
deps: HelperSessionRecordDeps,
): ZCodeProtocolSessionRecord {
  const { port, sessionId } = session;
  const workspace = session.workspace;
  const app: Partial<ZCodeApp> = {
    getPluginReferenceCatalog: () => session.catalog,
    listMcpServers: async () => port.status(),
    getMcpToolVisibility: async (serverName, toolName) => {
      const descriptor = (await port.listTools()).find(
        (tool) => tool.serverName === serverName && tool.toolName === toolName,
      );
      return descriptor ? resolveMcpToolVisibility(descriptor) : null;
    },
    readMcpResource: async (serverName, uri, options) => {
      if (!port.readResource) throw new Error("MCP resources are not supported by this runtime");
      return port.readResource({ serverName, uri, trace: session.traceContext }, { signal: options?.signal });
    },
    readMcpResourceForUi: async (serverName, uri, options) => {
      if (!port.readResource) throw new Error("MCP resources are not supported by this runtime");
      return port.readResource({ serverName, uri, trace: session.traceContext }, { signal: options?.signal });
    },
    listMcpResourcesForUi: async (serverName, cursor, options) => {
      if (!port.listResources) throw new McpResourceSubscribeUnsupportedError(serverName);
      return port.listResources(
        { serverName, ...(cursor ? { cursor } : {}), trace: session.traceContext },
        { signal: options?.signal },
      );
    },
    listMcpResourceTemplatesForUi: async (serverName, cursor, options) => {
      if (!port.listResourceTemplates) throw new McpResourceSubscribeUnsupportedError(serverName);
      return port.listResourceTemplates(
        { serverName, ...(cursor ? { cursor } : {}), trace: session.traceContext },
        { signal: options?.signal },
      );
    },
    subscribeMcpResourceForUi: async (serverName, uri, subscriberKey, options) => {
      if (!port.subscribeResource) throw new McpResourceSubscribeUnsupportedError(serverName);
      await port.subscribeResource(
        { serverName, uri, subscriberKey, trace: session.traceContext },
        { signal: options?.signal },
      );
    },
    unsubscribeMcpResourceForUi: async (serverName, uri, subscriberKey, options) => {
      if (!port.unsubscribeResource) return;
      await port.unsubscribeResource(
        { serverName, uri, subscriberKey, trace: session.traceContext },
        { signal: options?.signal },
      );
    },
    unsubscribeMcpResourcesForUi: async (prefix) =>
      port.unsubscribeResourcesBySubscriber ? port.unsubscribeResourcesBySubscriber(prefix) : 0,
    onMcpAppConnectionInvalidated: (name, listener) =>
      port.onAppConnectionInvalidated?.(name, listener) ?? (() => {}),
    getMcpAppConnectionSnapshot: (name) => port.appConnectionSnapshot?.(name) ?? null,
    waitForMcpAppConnection: async (name) =>
      port.waitForAppConnection
        ? port.waitForAppConnection(name)
        : (port.appConnectionSnapshot?.(name) ?? null),
    // Node's callMcpToolForUi (session-facade.ts), with the authorization run by the Rust agent.
    callMcpToolForUi: async (serverName, toolName, args, options) => {
      const snapshot = port.appConnectionSnapshot?.(serverName);
      if (!snapshot) throw new Error("MCP App connection is unavailable");
      const descriptor = (await port.listTools()).find(
        (tool) => tool.serverName === serverName && tool.toolName === toolName,
      );
      if (!descriptor || !resolveMcpToolVisibility(descriptor).includes("app"))
        throw new Error("Tool is not available to this App");
      let input: unknown;
      try {
        ({ input } = await deps.client.request<{ input: unknown }>(
          FORK_RUST_HELPER_F3.authorizeAppTool,
          {
            sessionId,
            serverName,
            toolName,
            input: args ?? {},
            tool: {
              ...(descriptor.description !== undefined ? { description: descriptor.description } : {}),
              inputSchema: descriptor.inputSchema,
              ...(descriptor.annotations !== undefined ? { annotations: descriptor.annotations } : {}),
            },
          },
          options?.signal,
        ));
      } catch (error) {
        throw toNodeError(error);
      }
      options?.signal?.throwIfAborted();
      const current = port.appConnectionSnapshot?.(serverName);
      if (!current || current.identity !== snapshot.identity || current.generation !== snapshot.generation)
        throw new Error("MCP App connection changed during authorization");
      return port.callTool(
        {
          serverName,
          toolName,
          arguments: (input ?? {}) as Record<string, unknown>,
          trace: session.traceContext,
          // Node's panel call sends no workspace fields (session-facade.ts:528-536): the session's
          // lease already runs in its directory.
          runtimeScope: "main",
        },
        { ...(options?.signal ? { signal: options.signal } : {}), appConnection: snapshot },
      );
    },
    // Node's registry needs the applied names at once; Rust only skips names that clash with its
    // own tools, which `app__` names never do, so the helper answers with the deduplicated set.
    replaceMcpAppProvidedTools: (definitions, execute) => {
      session.appTools.clear();
      for (const definition of definitions)
        if (!session.appTools.has(definition.modelName))
          session.appTools.set(definition.modelName, { definition, execute });
      const registered = [...session.appTools.keys()];
      void deps.client
        .request<{ registered?: string[] }>(FORK_RUST_HELPER_F3.appToolsReplace, {
          sessionId,
          tools: [...session.appTools.values()].map(({ definition }) => ({
            name: definition.modelName,
            modelName: definition.modelName,
            serverName: definition.serverName,
            pluginId: definition.pluginId,
            toolName: definition.toolName,
            ...(definition.title !== undefined ? { title: definition.title } : {}),
            ...(definition.description !== undefined ? { description: definition.description } : {}),
            inputSchema: definition.inputSchema,
            ...(definition.readOnlyHint !== undefined ? { readOnlyHint: definition.readOnlyHint } : {}),
            ...(definition.destructiveHint !== undefined
              ? { destructiveHint: definition.destructiveHint }
              : {}),
            ...(definition.idempotentHint !== undefined
              ? { idempotentHint: definition.idempotentHint }
              : {}),
          })),
        })
        .then((answer) => {
          const skipped = registered.filter((name) => !answer.registered?.includes(name));
          if (skipped.length > 0)
            deps.logger?.warn("Rust skipped app-provided tools", {
              event: "fork_rust_helper.app_tools.skipped",
              count: skipped.length,
            });
        })
        .catch((error: unknown) =>
          deps.logger?.warn("Rust app-provided tool registration failed", {
            event: "fork_rust_helper.app_tools.replace_failed",
            error: errorMessage(error),
          }),
        );
      return registered;
    },
    sampleModel: (input, options) =>
      deps.client.request(
        FORK_RUST_HELPER_F3.sampleModel,
        { sessionId, request: input.request, source: input.source },
        options.abortSignal,
      ) as ReturnType<ZCodeApp["sampleModel"]>,
  };
  return {
    app: app as ZCodeApp,
    traceContext: session.traceContext,
    workspace,
  } as unknown as ZCodeProtocolSessionRecord;
}

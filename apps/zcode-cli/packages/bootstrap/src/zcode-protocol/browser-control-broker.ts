import { randomUUID } from "node:crypto";
import type { BrowserControlPort, TraceContext } from "@zcode/contracts";
import {
  zcodeBrowserExecuteResultSchema,
  zcodeBrowserListResultSchema,
  zcodeProtocolMethods,
} from "@zcode/shared";
import {
  protocolTraceFromTraceContext,
  requireSession,
  type ZCodeProtocolAgentServerContext,
  type ZCodeProtocolClientRequestOptions,
} from "./server-types.js";

/**
 * Broker state for one server context. The broker is created twice within the same context—the
 * process-level node_repl broker (server.ts) and the per-app runtime port
 * (server-operations.ts)—so the state must be shared.
 *
 * Root cause of a bug (2026-09-30): connection memory used to live in separate closures.
 * node_repl's execute recorded on the process-level instance, while runtime's turnEnded /
 * closeSession went through the app instance, which had only seen the commands the app instance
 * itself sent (end-of-turn screenshots). Lifecycle therefore reached the desktop only on turns
 * that happened to take a screenshot (desktop log 2026-09-30: session sess_fc6b0f61 used
 * Browser but not a single turnEnded arrived). Child-session registration had the same problem:
 * the actor runtime registered on the app instance while the actor's browser requests arrived via
 * the process-level instance.
 */
type BrowserRoute = Omit<ReturnType<typeof buildBrowserRequestContext>, "requestId" | "turnId">;
interface BrowserConnection {
  browserId: string;
  browserGeneration: number;
  route: BrowserRoute;
  controlScopeId?: string;
  opening?: Promise<void>;
  closing?: boolean;
}

interface ProtocolBrowserBrokerState {
  scopedBackends: Set<string>;
  connectionsBySession: Map<string, Map<string, BrowserConnection>>;
  /** Child sessions the client does not know about (dwf / core Agent subagents) → the client session that spawned them. Written only by forChildSession. */
  childSessionParents: Map<string, { parentSessionId: string }>;
  /** Child sessions whose tabs are owned by the parent session (core Agent subagents, tabOwner: "parent"). */
  parentTabOwnerChildren: Set<string>;
}

const brokerStateByContext = new WeakMap<
  ZCodeProtocolAgentServerContext,
  ProtocolBrowserBrokerState
>();

function brokerState(context: ZCodeProtocolAgentServerContext): ProtocolBrowserBrokerState {
  let state = brokerStateByContext.get(context);
  if (!state) {
    state = {
      scopedBackends: new Set(),
      connectionsBySession: new Map(),
      childSessionParents: new Map(),
      parentTabOwnerChildren: new Set(),
    };
    brokerStateByContext.set(context, state);
  }
  return state;
}

/**
 * ProtocolBrowserControlBroker — agent-side BrowserControlPort implementation.
 *
 * Each browser-client agent.browsers.* call goes through here to turn a BrowserCommand into a
 * ZCode Protocol interaction/browserExecute reverse request, executed by the app
 * (host→main webview/CDP) with the result returned. Injected alongside the permission broker
 * (createWorkspaceZCodeApp options in server-operations).
 */
export function createProtocolBrowserControlBroker(
  context: ZCodeProtocolAgentServerContext,
): BrowserControlPort {
  const state = brokerState(context);
  const { connectionsBySession, childSessionParents } = state;

  const rememberConnection = (
    {
      requestId: _requestId,
      turnId: _turnId,
      ...route
    }: ReturnType<typeof buildBrowserRequestContext>,
    browserId: string,
    browserGeneration: number,
  ) => {
    const connections = connectionsBySession.get(route.sessionId) ?? new Map();
    const backendKey = `${browserId}\u0000${browserGeneration}`;
    // Routing is part of the resource identity; mobile/desktop and remote scopes must not overwrite each other.
    const key = JSON.stringify([
      browserId,
      browserGeneration,
      route.workspaceKey,
      route.workspaceIdentity,
      route.remoteSessionId,
      route.clientMode,
    ]);
    const existing = connections.get(key);
    const connection: BrowserConnection = existing?.controlScopeId
      ? existing
      : { browserId, browserGeneration, route };
    connections.set(key, connection);
    connectionsBySession.set(route.sessionId, connections);
    if (state.scopedBackends.has(backendKey)) connection.controlScopeId ??= randomUUID();
    if (connection.controlScopeId && !connection.opening && !connection.closing) {
      connection.opening = (async () => {
        const result = await context.requestClient(
          zcodeProtocolMethods.interactionBrowserExecute,
          {
            ...route,
            requestId: randomUUID(),
            browserId,
            browserGeneration,
            controlScopeId: connection.controlScopeId,
            command: { method: "openScope" },
          },
          zcodeBrowserExecuteResultSchema,
        );
        if (
          result.ok &&
          result.scope?.id === connection.controlScopeId &&
          result.scope?.state === "open"
        )
          return;
        // Revoke the record only when establishment is explicitly rejected; a timeout or lost response does not prove Main failed to register.
        if (
          result.scope?.id === connection.controlScopeId &&
          result.scope?.state === "rejected" &&
          connections.get(key) === connection
        ) {
          connections.delete(key);
          if (!connections.size && connectionsBySession.get(route.sessionId) === connections)
            connectionsBySession.delete(route.sessionId);
        }
        throw new Error(result.error?.message ?? "Browser scope admission was not confirmed");
      })().catch((error) => {
        // An unknown outcome keeps the release duty on the original id; a failed flight is not a permanent failure and the next business call can retry idempotently.
        connection.opening = undefined;
        throw error;
      });
    }
    return connection;
  };

  const sendLifecycle = async (
    sessionId: string,
    turnId: string | undefined,
    command:
      | { method: "turnEnded"; turnId?: string }
      | { method: "closeSession"; closeTabs?: boolean },
  ): Promise<void> => {
    const connections = connectionsBySession.get(sessionId);
    if (!connections) return;
    const results = await Promise.allSettled(
      [...connections].map(async ([key, connection]) => {
        const { browserId, browserGeneration, route, controlScopeId } = connection;
        if (command.method === "closeSession") connection.closing = true;
        // Wait for the establishment result first; a rejected establishment already deleted the record, an unknown outcome still leaves release confirmation to the owner.
        if (connection.opening) await connection.opening.catch(() => undefined);
        if (connections.get(key) !== connection) return;
        const result = await context.requestClient(
          zcodeProtocolMethods.interactionBrowserExecute,
          {
            ...route,
            requestId: randomUUID(),
            ...(turnId ? { turnId } : {}),
            browserId,
            browserGeneration,
            ...(controlScopeId ? { controlScopeId } : {}),
            command:
              controlScopeId && command.method === "closeSession"
                ? { method: "releaseScope", closeTabs: command.closeTabs }
                : command,
          },
          zcodeBrowserExecuteResultSchema,
        );
        if (!result.ok)
          throw new Error(result.error?.message ?? "Browser lifecycle request failed");
        if (
          controlScopeId &&
          command.method === "closeSession" &&
          (result.scope?.id !== controlScopeId ||
            !["released", "absent"].includes(result.scope.state))
        ) {
          throw new Error("Browser scope release was not confirmed by owner");
        }
        // allSettled must neither swallow failures nor let an old close callback delete a newer control resource registered afterwards.
        if (command.method === "closeSession" && connections.get(key) === connection) {
          connections.delete(key);
        }
      }),
    );
    if (connections.size === 0 && connectionsBySession.get(sessionId) === connections) {
      connectionsBySession.delete(sessionId);
    }
    const errors = results.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : [],
    );
    if (errors.length) throw new AggregateError(errors, "Browser lifecycle cleanup failed");
  };

  const port: BrowserControlPort = {
    async list({ sessionId, turnId, traceContext, signal }) {
      const result = await context.requestClient(
        zcodeProtocolMethods.interactionBrowserList,
        buildBrowserRequestContext(context, state, { sessionId, turnId, traceContext }),
        zcodeBrowserListResultSchema,
        buildRequestOptions(traceContext, signal),
      );
      for (const browser of result.browsers) {
        if (browser.metadata?.controlScopes === "1")
          state.scopedBackends.add(`${browser.id}\u0000${browser.generation}`);
      }
      return result.browsers;
    },

    async execute({
      browserId,
      browserGeneration,
      sessionId,
      turnId,
      command,
      traceContext,
      signal,
    }) {
      const requestContext = buildBrowserRequestContext(context, state, {
        sessionId,
        turnId,
        traceContext,
      });
      // Validate the session before recording the connection: rejected requests (unregistered /
      // closed child sessions) must not leave entries in the shared state.
      // Record the connection under the tab owner actually sent: a subagent sharing the parent
      // session's tab has its connections cleaned up by the parent session's lifecycle.
      const connection = rememberConnection(requestContext, browserId, browserGeneration);
      if (connection.closing) throw new Error("Browser control scope is closing");
      if (connection.opening) await connection.opening;
      if (connection.closing) throw new Error("Browser control scope is closing");
      const scopeContext = connection.controlScopeId
        ? { controlScopeId: connection.controlScopeId }
        : {};
      const cancelBackendRequest = () => {
        // Cancelling only the agent-side requestClient would leave the host/main CDP action running.
        // Send an internal cancelRequest with the same backend/generation so main interrupts the
        // waiter by the original requestId. If the dispatched action cannot be proven side-effect
        // free, the manager returns an uncertain marker.
        void context
          .requestClient(
            zcodeProtocolMethods.interactionBrowserExecute,
            {
              // Cancellation belongs to admitted requests; even with the runtime already stopping, desktop-side actions must remain cancellable.
              ...requestContext,
              ...scopeContext,
              requestId: randomUUID(),
              browserId,
              browserGeneration,
              command: { method: "cancelRequest", requestId: requestContext.requestId },
            },
            zcodeBrowserExecuteResultSchema,
            buildRequestOptions(traceContext, undefined),
          )
          .catch(() => undefined);
      };
      if (signal?.aborted) cancelBackendRequest();
      else signal?.addEventListener("abort", cancelBackendRequest, { once: true });
      try {
        return await context.requestClient(
          zcodeProtocolMethods.interactionBrowserExecute,
          {
            ...requestContext,
            ...scopeContext,
            browserId,
            browserGeneration,
            command,
          },
          zcodeBrowserExecuteResultSchema,
          buildRequestOptions(traceContext, signal),
        );
      } finally {
        signal?.removeEventListener("abort", cancelBackendRequest);
      }
    },

    async turnEnded({ sessionId, turnId }) {
      await sendLifecycle(sessionId, turnId, { method: "turnEnded", turnId });
    },

    async closeSession({ sessionId, turnId }) {
      await sendLifecycle(sessionId, turnId, { method: "closeSession" });
    },

    forChildSession({ childSessionId, parentSessionId, tabOwner = "child" }) {
      const binding = { parentSessionId };
      childSessionParents.set(childSessionId, binding);
      const release = () => {
        if (childSessionParents.get(childSessionId) !== binding) return;
        childSessionParents.delete(childSessionId);
        state.parentTabOwnerChildren.delete(childSessionId);
      };
      if (tabOwner === "parent") {
        state.parentTabOwnerChildren.add(childSessionId);
        // The tab belongs to the current conversation: neither the subagent's turn end nor its run
        // end may end / close the tab on the parent session's behalf—that would release the tab
        // the user is watching. Cleanup is the parent session's own turnEnded / closeSession job.
        return {
          list: port.list,
          execute: port.execute,
          async turnEnded() {},
          async closeSession() {
            release();
          },
        };
      }
      state.parentTabOwnerChildren.delete(childSessionId);
      return {
        list: port.list,
        execute: port.execute,
        turnEnded: port.turnEnded,
        async closeSession({ sessionId, turnId }) {
          if (childSessionParents.get(childSessionId) !== binding) return;
          // The standalone child session's temporary tab must be closed; on failure keep the resource and binding for the owner's final cleanup retry.
          await sendLifecycle(sessionId, turnId, { method: "closeSession", closeTabs: true });
          release();
        },
      };
    },
  };
  return port;
}

function buildBrowserRequestContext(
  context: ZCodeProtocolAgentServerContext,
  state: ProtocolBrowserBrokerState,
  input: {
    sessionId: string;
    turnId?: string;
    traceContext?: TraceContext;
  },
) {
  // A child session's workspace / clientMode come from the client session that spawned it; the
  // sessionId sent is the tab owner for the desktop browser scope, not the routing identity
  // (docs/zcode-protocol-model-backed-control-requests.md contract 4): dwf subagents use the
  // child session's own, core Agent subagents use the parent session's. Without a registration,
  // look up by the original id and reject if not found.
  const parentSessionId = state.childSessionParents.get(input.sessionId)?.parentSessionId;
  const record = requireSession(context, parentSessionId ?? input.sessionId);
  const workspaceIdentity = record.workspace.workspaceIdentity?.trim() || undefined;
  const remoteSessionId = record.workspace.remoteSessionId?.trim() || undefined;
  const workspacePath = record.workspace.workspacePath;

  return {
    requestId: randomUUID(),
    // core Agent subagents share the parent session's tab: the desktop decides tab ownership and
    // panel expansion by sessionId, and it does not know the child session id—a tab opened with it
    // neither expands the panel nor shows up in any conversation.
    sessionId:
      parentSessionId !== undefined && state.parentTabOwnerChildren.has(input.sessionId)
        ? parentSessionId
        : input.sessionId,
    ...((input.turnId ?? input.traceContext?.turnId)
      ? { turnId: String(input.turnId ?? input.traceContext?.turnId) }
      : {}),
    // workspacePath may be the same in different remote workspaces. Prefer workspaceIdentity as the
    // isolation key so browser backend/tab ownership cannot cross between workspaces.
    workspaceKey: workspaceIdentity ?? workspacePath,
    workspacePath,
    ...(workspaceIdentity ? { workspaceIdentity } : {}),
    ...(remoteSessionId ? { remoteSessionId } : {}),
    clientMode: record.deliveryKind ?? "desktop-continuous",
    sessionContext: "live" as const,
  };
}

function buildRequestOptions(
  traceContext: TraceContext | undefined,
  signal: AbortSignal | undefined,
): ZCodeProtocolClientRequestOptions {
  return {
    ...(signal ? { signal } : {}),
    ...(traceContext ? { trace: protocolTraceFromTraceContext(traceContext) } : {}),
  };
}

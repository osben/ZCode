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
interface ProtocolBrowserBrokerState {
  connectionsBySession: Map<string, Map<string, { browserId: string; browserGeneration: number }>>;
  /** Child sessions the client does not know about (dwf / core Agent subagents) → the client session that spawned them. Written only by forChildSession. */
  childSessionParents: Map<string, string>;
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
 * Each browser-client `agent.browsers.*` call uses this to turn a BrowserCommand into a ZCode
 * Protocol interaction/browserExecute reverse request. The app executes it (host → main
 * WebContentsView/CDP) and returns the result. Injected alongside the permission broker through
 * server-operations' createWorkspaceZCodeApp options.
 */
export function createProtocolBrowserControlBroker(
  context: ZCodeProtocolAgentServerContext,
): BrowserControlPort {
  const state = brokerState(context);
  const { connectionsBySession, childSessionParents } = state;

  const rememberConnection = (sessionId: string, browserId: string, browserGeneration: number) => {
    const connections = connectionsBySession.get(sessionId) ?? new Map();
    connections.set(`${browserId}\u0000${browserGeneration}`, { browserId, browserGeneration });
    connectionsBySession.set(sessionId, connections);
  };

  const sendLifecycle = async (
    sessionId: string,
    turnId: string | undefined,
    command:
      | { method: "turnEnded"; turnId?: string }
      | { method: "closeSession"; closeTabs?: boolean },
  ): Promise<void> => {
    const connections = [...(connectionsBySession.get(sessionId)?.values() ?? [])];
    await Promise.allSettled(
      connections.map(({ browserId, browserGeneration }) =>
        context.requestClient(
          zcodeProtocolMethods.interactionBrowserExecute,
          {
            ...buildBrowserRequestContext(context, state, { sessionId, turnId }),
            browserId,
            browserGeneration,
            command,
          },
          zcodeBrowserExecuteResultSchema,
        ),
      ),
    );
  };

  const port: BrowserControlPort = {
    async list({ sessionId, turnId, traceContext, signal }) {
      const result = await context.requestClient(
        zcodeProtocolMethods.interactionBrowserList,
        buildBrowserRequestContext(context, state, { sessionId, turnId, traceContext }),
        zcodeBrowserListResultSchema,
        buildRequestOptions(traceContext, signal),
      );
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
      rememberConnection(requestContext.sessionId, browserId, browserGeneration);
      const cancelBackendRequest = () => {
        // Cancelling only the agent-side requestClient would leave the host/main CDP action running.
        // Send an internal cancelRequest with the same backend/generation so main interrupts the
        // waiter by the original requestId. If the dispatched action cannot be proven side-effect
        // free, the manager returns an uncertain marker.
        void context
          .requestClient(
            zcodeProtocolMethods.interactionBrowserExecute,
            {
              ...buildBrowserRequestContext(context, state, { sessionId, turnId, traceContext }),
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
      connectionsBySession.delete(sessionId);
    },

    forChildSession({ childSessionId, parentSessionId, tabOwner = "child" }) {
      childSessionParents.set(childSessionId, parentSessionId);
      if (tabOwner === "parent") {
        state.parentTabOwnerChildren.add(childSessionId);
        const release = () => {
          if (childSessionParents.get(childSessionId) !== parentSessionId) return;
          childSessionParents.delete(childSessionId);
          state.parentTabOwnerChildren.delete(childSessionId);
        };
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
      return {
        list: port.list,
        execute: port.execute,
        turnEnded: port.turnEnded,
        async closeSession({ sessionId, turnId }) {
          try {
            // The child session will never come back as a conversation to claim the tab: a kept
            // view is visible to no one and only holds a guest alive.
            await sendLifecycle(sessionId, turnId, { method: "closeSession", closeTabs: true });
          } finally {
            connectionsBySession.delete(sessionId);
            if (childSessionParents.get(childSessionId) === parentSessionId) {
              childSessionParents.delete(childSessionId);
            }
          }
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
  const parentSessionId = state.childSessionParents.get(input.sessionId);
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

// ============================================================
// Derive child-runtime client-facing interaction ports (the only entry point)
// ============================================================
//
// A child runtime has two session identity axes:
//   Ledger identity, sessionId — event persistence / transcript / trace / session store; the child uses its own.
//   Routing identity — all agent → app reverse requests (permission, AskUserQuestion, provider runtime headers); the child must use
//                      the parent's identity, up to the root session.
// Clients know only the root session. If a child session makes the request, Desktop cannot find it, never sends a response, and the child hangs.
//
// Previously this rule was scattered across child assembly sites: core's subagent had two private wrappers, while DWF actors and
// legacy workflow children passed appOptions ports straight through—two wrong and one correct. Consolidate derivation here and have
// the **parent runtime** call it (`AgentRuntime.createChildClientPorts`). The parent supplies `parentSessionId`, so callers cannot pass the wrong value.

import type { PermissionBrokerPort, SessionId } from "../deps.js";
import type { ProviderRuntimeHeadersPort } from "../types.js";
import type { SubagentInteractionOriginContext } from "../../subagent/interaction-origin.js";
import { createSubagentInteractionBroker } from "./subagent-interaction-broker.js";

/** A runtime's ports for the protocol client. */
export interface ClientFacingPorts {
  permissionBroker?: PermissionBrokerPort;
  providerRuntimeHeadersPort?: ProviderRuntimeHeadersPort;
}

/**
 * Ownership information needed to create a child. `parentSessionId` is intentionally absent; only the parent runtime may provide it,
 * mechanically guaranteeing the correct routing identity.
 */
export type ChildClientPortsContext = Omit<SubagentInteractionOriginContext, "parentSessionId">;

/**
 * Derive a child's client-facing ports from its parent's ports.
 *
 * - `providerRuntimeHeadersPort`: wrap it to rewrite the input `sessionId` to the parent session (the primary runtime reports its own
 *   session; see methods/model-runtime-headers.ts). With nested children, **outer layers write last** (the layer closest to the client
 *   executes last), so the final value is always the root session.
 * - `permissionBroker`: similarly wrap it to rewrite `request.sessionId`; preserve the innermost existing `origin` so outer layers do
 *   not erase subagent attribution.
 */
export function deriveChildClientPorts(
  parent: ClientFacingPorts,
  context: ChildClientPortsContext & { parentSessionId: SessionId },
): ClientFacingPorts {
  return {
    ...(parent.permissionBroker === undefined
      ? {}
      : { permissionBroker: createSubagentInteractionBroker(parent.permissionBroker, context) }),
    ...(parent.providerRuntimeHeadersPort === undefined
      ? {}
      : {
          providerRuntimeHeadersPort: rerouteProviderRuntimeHeadersPort(
            parent.providerRuntimeHeadersPort,
            context.parentSessionId,
          ),
        }),
  };
}

/**
 * Provider runtime headers are an independent reverse protocol request and are not mirrored as child events. A child sessionId is
 * only an internal CLI ledger identity; Desktop subscribes to the parent task's session, so refresh account-credential headers through
 * the parent session. The service checks whether the request model matches the parent's current model; if not, it syncs only this
 * request's header without switching the parent session to the child's model.
 */
function rerouteProviderRuntimeHeadersPort(
  parentPort: ProviderRuntimeHeadersPort,
  parentSessionId: SessionId,
): ProviderRuntimeHeadersPort {
  return {
    shouldRefreshBeforeModelRequest(input) {
      return parentPort.shouldRefreshBeforeModelRequest?.(input) ?? true;
    },
    refreshBeforeModelRequest(input) {
      return parentPort.refreshBeforeModelRequest({ ...input, sessionId: parentSessionId });
    },
  };
}

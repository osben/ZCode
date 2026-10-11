import type {
  PermissionBrokerPort,
  PermissionBrokerRequest,
  PermissionBrokerRequestOptions,
} from "../deps.js";
import {
  buildSubagentInteractionOrigin,
  type SubagentInteractionOriginContext,
} from "../../subagent/interaction-origin.js";

export interface SubagentInteractionBrokerContext extends SubagentInteractionOriginContext {
  parentToolCallId?: PermissionBrokerRequest["toolCallId"] | string;
}

type BrokerResponse = ReturnType<PermissionBrokerPort["requestPermission"]>;

export function createSubagentInteractionBroker(
  parentBroker: PermissionBrokerPort,
  context: SubagentInteractionBrokerContext,
): PermissionBrokerPort {
  return {
    requestPermission(
      request: PermissionBrokerRequest,
      options?: PermissionBrokerRequestOptions,
    ): BrokerResponse {
      // Reason for the fix: child-agent permission / AskUserQuestion / ExitPlanMode requests need a response from the parent task's UI;
      // route the broker request to the parent session while preserving the child in origin so the UI and logs can identify its source.
      // Contract (2026-09-17 review): `registered` is a property attached to the Promise; this function must return the parent's broker response object unchanged.
      // Do not make this function async or wrap the response in `.then`, or the signal will be silently lost, the executor will assume synchronous registration,
      // and the race where a confirmation dialog is visible but its deferred operation was not registered will return. subagent-interaction-broker.test.ts guards this identity.
      //
      // This wrapper may be nested. `sessionId` is rewritten last by the **outermost** layer (closest to the client),
      // so any depth ultimately routes to the root session. `origin` instead preserves the existing **innermost** value,
      // keeping ownership with the child agent that actually made the request instead of letting an outer layer replace it with an intermediate agent.
      return parentBroker.requestPermission(
        {
          ...request,
          sessionId: context.parentSessionId,
          origin: request.origin ?? buildSubagentInteractionOrigin(context, request.turnId),
        },
        options,
      );
    },
  };
}

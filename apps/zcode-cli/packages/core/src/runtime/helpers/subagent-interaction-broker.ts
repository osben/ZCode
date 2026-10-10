import type {
  PermissionBrokerPort,
  PermissionBrokerRequest,
  PermissionBrokerRequestOptions,
  PermissionBrokerResult,
} from "../deps.js";
import {
  buildSubagentInteractionOrigin,
  type SubagentInteractionOriginContext,
} from "../../subagent/interaction-origin.js";

interface SubagentInteractionBrokerContext extends SubagentInteractionOriginContext {
  parentToolCallId?: PermissionBrokerRequest["toolCallId"] | string;
}

export function createSubagentInteractionBroker(
  parentBroker: PermissionBrokerPort,
  context: SubagentInteractionBrokerContext,
): PermissionBrokerPort {
  return {
    requestPermission(
      request: PermissionBrokerRequest,
      options?: PermissionBrokerRequestOptions,
    ): Promise<PermissionBrokerResult> {
      // The parent's task UI must respond to child-agent permission / AskUserQuestion / ExitPlanMode requests.
      // Route broker requests outward to the parent session while origin retains child ownership so UI and logs can identify the source.
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

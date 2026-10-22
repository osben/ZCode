/**
 * Session facts of an external agent turn that are not transcript rows (specs/acp-agent-runtime.md
 * "S6: agent configuration options").
 *
 * `external_agent_config_updated` carries the agent's offered options to the session config
 * projection; `external_agent_status` carries a stall and its resume as a transient turn status.
 * Neither writes a message or a part.
 */
import {
  SessionEventType,
  type ExternalAgentConfigOption,
  type ExternalAgentConfigUpdatedPayload,
  type ExternalAgentStatusPayload,
  type TraceContext,
} from "@zcode/contracts";
import type { AgentRuntimeInternal } from "../internal.js";
import type { RegularTurnLoopState } from "./turn-loop-state.js";

export async function appendExternalAgentConfig(
  runtime: AgentRuntimeInternal,
  state: RegularTurnLoopState,
  agentId: string,
  options: readonly ExternalAgentConfigOption[],
): Promise<void> {
  const payload: ExternalAgentConfigUpdatedPayload = { agentId, options };
  await append(runtime, state, SessionEventType.ExternalAgentConfigUpdated, payload);
}

export async function appendExternalAgentStatus(
  runtime: AgentRuntimeInternal,
  state: RegularTurnLoopState,
  payload: ExternalAgentStatusPayload,
): Promise<void> {
  await append(runtime, state, SessionEventType.ExternalAgentStatus, payload);
}

async function append(
  runtime: AgentRuntimeInternal,
  state: RegularTurnLoopState,
  type: SessionEventType,
  payload: unknown,
): Promise<void> {
  const traceContext: TraceContext = state.turnTraceContext;
  const event = runtime.createEvent(type, payload, traceContext);
  await runtime.appendEvent(event, traceContext);
  state.events.push(event);
}

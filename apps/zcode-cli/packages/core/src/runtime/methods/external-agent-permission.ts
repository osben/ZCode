/**
 * User-once permission asks of an external agent turn (specs/acp-agent-runtime.md "S4").
 *
 * An ACP `session/request_permission` becomes the broker's user-once prompt for the agent's tool row.
 * ZCode's permission service is not consulted, so no ZCode mode answers the ask. Every ask ends with
 * exactly one `PermissionResolved` once its `PermissionRequested` was emitted. An abort resolves the
 * ask `cancelled` and the turn waits for that resolution before it writes its terminal event.
 */
import {
  SessionEventType,
  type PermissionBrokerRequest,
  type PermissionBrokerResult,
  type PermissionDecision,
} from "@zcode/contracts";
import type { ExternalAgentPermissionAnswer, ExternalAgentPermissionAsk } from "@zcode/contracts";
import type { AgentRuntimeInternal } from "../internal.js";
import type { RegularTurnLoopState } from "./turn-loop-state.js";
import type { ExternalAgentToolRows } from "./external-agent-tool-rows.js";

/** Rule id on the broker request; the prompt is a user-once confirmation, not a ZCode rule. */
export const EXTERNAL_AGENT_PERMISSION_RULE_ID = "acp.permission.user_once";
/** Risk shown on the prompt. ACP asks do not carry a risk level, so one fixed level applies. */
export const EXTERNAL_AGENT_PERMISSION_RISK = "medium";
export const EXTERNAL_AGENT_PERMISSION_CANCELLED_REASON = "Permission request cancelled";
const EXTERNAL_AGENT_PERMISSION_DENIED_REASON = "Denied by the user";

export interface ExternalAgentPermissionContext {
  readonly state: RegularTurnLoopState;
  readonly rows: ExternalAgentToolRows;
}

export async function answerExternalAgentPermission(
  this: AgentRuntimeInternal,
  context: ExternalAgentPermissionContext,
  ask: ExternalAgentPermissionAsk,
): Promise<ExternalAgentPermissionAnswer> {
  const signal = context.state.turnAbortSignal;
  if (signal.aborted) return "cancelled";
  const traceContext = context.state.turnTraceContext;
  const row = await context.rows.rowFor(ask.toolCallId);
  const requestId = `perm_${crypto.randomUUID()}`;
  const reason = ask.title.trim().length > 0 ? ask.title : `${row.toolName} needs your approval`;
  const request: PermissionBrokerRequest = {
    approvalMode: "user-once",
    requestId,
    sessionId: this.sessionId,
    ...(traceContext.turnId === undefined ? {} : { turnId: traceContext.turnId }),
    traceId: traceContext.traceId,
    toolCallId: row.toolCallId,
    toolName: row.toolName,
    input: { title: ask.title, ...(ask.detail ? { detail: ask.detail } : {}) },
    // ACP asks always need the user, so they carry the strictest mode whatever the ZCode mode is.
    mode: "guarded",
    ruleId: EXTERNAL_AGENT_PERMISSION_RULE_ID,
    reason,
    riskLevel: EXTERNAL_AGENT_PERMISSION_RISK,
    requestedAt: new Date(),
  };

  const response = this.permissionBroker.requestPermission(request, { signal });
  // A rejected broker call is handled below; this keeps the promise from being unhandled when the
  // turn aborts before the race reads it.
  response.catch(() => undefined);
  const aborted = new Promise<"aborted">((resolve) => {
    signal.addEventListener("abort", () => resolve("aborted"), { once: true });
  });

  // Once the handler starts, every ask publishes its request and exactly one resolution, even when the
  // turn aborts first; the replay therefore never keeps a dialog without its end.
  let decision: PermissionBrokerResult | "aborted" | undefined;
  try {
    await Promise.race([response.registered ?? Promise.resolve(), aborted]);
    await appendEvent(this, context.state, SessionEventType.PermissionRequested, {
      requestId,
      approvalMode: "user-once",
      toolCallId: row.toolCallId,
      toolName: row.toolName,
      riskLevel: EXTERNAL_AGENT_PERMISSION_RISK,
      reason,
      input: request.input,
      suggestedPermissionUpdates: [],
    });
    decision = signal.aborted ? "aborted" : await Promise.race([response, aborted]);
  } catch {
    // A broker failure (no client, transport error) counts as an unanswered ask.
    decision = undefined;
  }
  const resolved = resolveAnswer(decision, signal.aborted);
  await appendEvent(this, context.state, SessionEventType.PermissionResolved, {
    requestId,
    toolCallId: row.toolCallId,
    decision: resolved.decision,
    reason: resolved.reason,
  });
  return resolved.answer;
}

function resolveAnswer(
  decision: PermissionBrokerResult | "aborted" | undefined,
  turnAborted: boolean,
): { answer: ExternalAgentPermissionAnswer; decision: PermissionDecision; reason: string } {
  if (turnAborted || decision === undefined || decision === "aborted") {
    return {
      answer: "cancelled",
      decision: "deny",
      reason: EXTERNAL_AGENT_PERMISSION_CANCELLED_REASON,
    };
  }
  if (decision.decision === "allow") {
    return { answer: "allow", decision: "allow", reason: decision.reason ?? "Approved once" };
  }
  return {
    answer: "deny",
    decision: "deny",
    reason: decision.reason?.trim() || EXTERNAL_AGENT_PERMISSION_DENIED_REASON,
  };
}

async function appendEvent(
  runtime: AgentRuntimeInternal,
  state: RegularTurnLoopState,
  type: SessionEventType,
  payload: unknown,
): Promise<void> {
  const event = runtime.createEvent(type, payload, state.turnTraceContext);
  await runtime.appendEvent(event, state.turnTraceContext);
  state.events.push(event);
}

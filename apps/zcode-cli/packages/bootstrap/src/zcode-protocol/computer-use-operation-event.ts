import { SessionEventType, type SessionEvent } from "@zcode/contracts";
import type { ZCodeComputerUseOperationEvent } from "@zcode/shared";

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Whether this cell uses Computer Use.
 *
 * Perform only a boolean check; do not extract action names from source code. Source patterns may
 * change as the node_repl SDK evolves (for example, to `getApp()` + a bound object + `computer.*`),
 * and string matching will eventually miss them. Test fixtures can also accidentally provide a
 * flattened form that the SDK never produces, making CI falsely pass.
 *
 * Use `setupComputerUseRuntime` as the anchor because it is a bootstrap statement the model **must
 * copy verbatim**. This is an architectural constraint, not a soft documentation requirement: each
 * ZCode node_repl cell runs in a fresh Worker, and SDK bindings do not cross cells. The reference
 * documentation states: "The first executable statement of every CUA cell must be this bootstrap,
 * and the bootstrap and the actions must be in the same cell." Every cell using CUA therefore contains it.
 *
 * Browser Use's `agent.browsers.*` does not contain this bootstrap and will not match.
 */
function usesComputerUse(input: unknown): boolean {
  const code = nonEmptyString(asRecord(input).code);
  if (!code) return false;
  return code.includes("setupComputerUseRuntime");
}

function baseEvent(event: SessionEvent) {
  return {
    eventId: String(event.id),
    sequenceNumber: event.sequenceNumber,
    sessionId: String(event.sessionId),
    timestamp: event.timestamp.getTime(),
  };
}

export function mapComputerUseOperationEvent(
  event: SessionEvent,
): ZCodeComputerUseOperationEvent | undefined {
  const turnId = event.turnId ? String(event.turnId) : undefined;
  const payload = asRecord(event.payload);
  switch (event.type) {
    case SessionEventType.TurnStarted:
      return turnId ? { ...baseEvent(event), kind: "turn-started", turnId } : undefined;
    case SessionEventType.TurnComplete:
      return turnId ? { ...baseEvent(event), kind: "turn-completed", turnId } : undefined;
    case SessionEventType.TurnError:
      return turnId ? { ...baseEvent(event), kind: "turn-failed", turnId } : undefined;
    case SessionEventType.ToolCallScheduled: {
      const toolCallId = nonEmptyString(payload.toolCallId);
      const toolName = nonEmptyString(payload.toolName);
      return turnId && toolCallId && toolName
        ? {
            ...baseEvent(event),
            kind: "tool-scheduled",
            turnId,
            toolCallId,
            toolName,
            ...(toolName === "mcp__node_repl__js" && usesComputerUse(payload.input)
              ? { computerUse: true as const }
              : {}),
          }
        : undefined;
    }
    case SessionEventType.ToolCallStarted: {
      const toolCallId = nonEmptyString(payload.toolCallId);
      if (!toolCallId) return undefined;
      const toolName = nonEmptyString(payload.toolName);
      return {
        ...baseEvent(event),
        kind: "tool-started",
        ...(turnId ? { turnId } : {}),
        toolCallId,
        ...(toolName ? { toolName } : {}),
      };
    }
    case SessionEventType.SessionEnded:
      return { ...baseEvent(event), kind: "session-closed" };
    default:
      return undefined;
  }
}

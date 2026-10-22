/**
 * Permission bridge helpers.
 *
 * `session/request_permission` options are matched strictly by `kind`
 * (`allow_once` / `allow_always` / `reject_once` / `reject_always`); the
 * `optionId` strings differ between agents (verified: opencode vs cursor) and
 * must never be assumed.
 */
import { randomUUID } from "node:crypto";
import type { RequestPermissionRequest, RequestPermissionResponse } from "@agentclientprotocol/sdk";
import { CANCELLED_ANSWER, createDeferred, type Deferred } from "./runtime-helpers.js";
import type { AcpHostBridge, AcpPermissionAsk, AcpPermissionAnswer } from "./types.js";

export interface AcpPermissionTurn {
  readonly generation: number;
  /** True while the ask belongs to the live turn (current generation and session, prompting). */
  readonly isLive: (sessionId?: string) => boolean;
  readonly askBridge: AcpHostBridge["requestPermission"];
  /** Owned by the runtime; every teardown resolves the entries `cancelled`. */
  readonly pendingAsks: Map<string, Deferred<AcpPermissionAnswer>>;
}

/**
 * Resolves every pending host ask `cancelled`: teardown, exit, stop, and `cancel()`. ACP requires the
 * client to answer asks before a cancelled turn can settle; an agent waiting on its ask never would.
 */
export function cancelPendingAsks(pendingAsks: Map<string, Deferred<AcpPermissionAnswer>>): void {
  for (const deferred of pendingAsks.values()) deferred.resolve(CANCELLED_ANSWER);
  pendingAsks.clear();
}

/**
 * Answers one `session/request_permission`. Stale (restarted), orphaned (torn
 * down, out-of-turn) and foreign-session asks never reach the host and are
 * answered `cancelled`; a host decision that arrives after the turn ended is
 * never applied.
 */
export async function answerPermissionRequest(
  request: RequestPermissionRequest,
  turn: AcpPermissionTurn,
): Promise<RequestPermissionResponse> {
  const askBridge = turn.askBridge;
  if (!turn.isLive(request.sessionId) || !askBridge) {
    return toPermissionResponse(request, CANCELLED_ANSWER);
  }
  const requestId = `${turn.generation}:${request.toolCall.toolCallId}:${randomUUID()}`;
  const deferred = createDeferred<AcpPermissionAnswer>();
  turn.pendingAsks.set(requestId, deferred);
  try {
    const answer = await Promise.race([
      askBridge(buildPermissionAsk(request, requestId)).catch(() => CANCELLED_ANSWER),
      deferred.promise,
    ]);
    return toPermissionResponse(request, turn.isLive() ? answer : CANCELLED_ANSWER);
  } finally {
    turn.pendingAsks.delete(requestId);
  }
}

/** Builds the host-facing ask payload from the raw ACP request. */
export function buildPermissionAsk(
  request: RequestPermissionRequest,
  requestId: string,
): AcpPermissionAsk {
  return {
    requestId,
    sessionId: request.sessionId,
    toolCallId: request.toolCall.toolCallId,
    title: typeof request.toolCall.title === "string" ? request.toolCall.title : "",
    detail: extractPermissionDetail(request),
    options: request.options.map((option) => ({
      optionId: option.optionId,
      kind: option.kind,
      name: option.name,
    })),
    raw: request,
  };
}

/** Extracts the first plain-text tool call content block, when present. */
export function extractPermissionDetail(request: RequestPermissionRequest): string | null {
  const content = request.toolCall.content;
  if (!Array.isArray(content)) return null;
  for (const item of content) {
    if (!item || typeof item !== "object") continue;
    if ((item as { type?: unknown }).type !== "content") continue;
    const inner = (item as { content?: unknown }).content;
    if (!inner || typeof inner !== "object") continue;
    if ((inner as { type?: unknown }).type !== "text") continue;
    const text = (inner as { text?: unknown }).text;
    if (typeof text === "string" && text.length > 0) return text;
  }
  return null;
}

/**
 * Converts a host answer into the ACP response: the answered `kind` is mapped
 * onto the matching optionId of this request. An unavailable kind (stale or
 * mismatched) degrades to `cancelled` — never to an implicit allow.
 */
export function toPermissionResponse(
  request: RequestPermissionRequest,
  answer: AcpPermissionAnswer,
): RequestPermissionResponse {
  if (answer.outcome === "selected") {
    const match = request.options.find((option) => option.kind === answer.kind);
    if (match) {
      return { outcome: { outcome: "selected", optionId: match.optionId } };
    }
  }
  return { outcome: { outcome: "cancelled" } };
}

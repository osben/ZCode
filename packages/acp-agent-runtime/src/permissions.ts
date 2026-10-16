/**
 * Permission bridge helpers.
 *
 * `session/request_permission` options are matched strictly by `kind`
 * (`allow_once` / `allow_always` / `reject_once` / `reject_always`); the
 * `optionId` strings differ between agents (verified: opencode vs cursor) and
 * must never be assumed.
 */
import type { RequestPermissionRequest, RequestPermissionResponse } from "@agentclientprotocol/sdk";
import type { AcpPermissionAsk, AcpPermissionAnswer } from "./types.js";

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
 * Converts a host answer into the ACP response. An unknown `optionId`
 * (stale or mismatched) degrades to `cancelled` — never to an implicit allow.
 */
export function toPermissionResponse(
  request: RequestPermissionRequest,
  answer: AcpPermissionAnswer,
): RequestPermissionResponse {
  if (answer.outcome === "selected") {
    const match = request.options.find((option) => option.optionId === answer.optionId);
    if (match) {
      return { outcome: { outcome: "selected", optionId: match.optionId } };
    }
  }
  return { outcome: { outcome: "cancelled" } };
}

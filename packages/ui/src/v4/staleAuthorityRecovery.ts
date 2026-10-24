import type { CommandAck } from "@zcode/shared/zcode-protocol-v4";

const STALE_AUTHORITY_REASON_CODES = new Set([
  "proto.staleLogEpoch",
  "proto.staleRevision",
  "proto.staleTarget",
]);

function faultReasonCode(value: unknown): string | undefined {
  if (value instanceof Error) return value.message;
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const candidate = value as { status?: unknown; reasonCode?: unknown };
  if (candidate.status !== undefined && candidate.status !== "stale") return undefined;
  return typeof candidate.reasonCode === "string" ? candidate.reasonCode : undefined;
}

/** Use same-sub recovery when the authoritative projection for a row command/query has moved across revision/epoch/entity. */
export function shouldResyncForStaleAuthority(value: unknown): boolean {
  return STALE_AUTHORITY_REASON_CODES.has(faultReasonCode(value) ?? "");
}

/**
 * Queue item commands carry a session-wide CAS, but their intent is scoped to one queueItemId that the CLI
 * queue handler re-validates. The renderer revision lags the CLI publisher whenever a delta is still in
 * flight (ISSUE-072), so a `proto.staleRevision` ACK is re-sent once at the CLI's revisionAtDecision
 * (specs/queue-command-stale-revision.md). Other stale reasons change the target and are never retried.
 */
export async function dispatchQueueCommandWithStaleRetry(
  dispatch: (baseRevision: number) => Promise<CommandAck>,
  baseRevision: number,
): Promise<CommandAck> {
  const ack = await dispatch(baseRevision);
  if (ack.status !== "stale" || ack.reasonCode !== "proto.staleRevision") return ack;
  return dispatch(ack.revisionAtDecision);
}

/** Final ACK statuses after which the queue already reflects the user's action (rules 4–5). */
export function isQueueCommandSettledAck(status: CommandAck["status"]): boolean {
  return status === "accepted" || status === "duplicate" || status === "noop";
}

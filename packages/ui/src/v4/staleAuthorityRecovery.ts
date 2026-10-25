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

// Steer lost the race to the auto-drain or the turn end: the item is already running or will drain next,
// so a failure toast would contradict what the user sees (specs/queue-command-stale-revision.md rule 5).
const STEER_SUPERSEDED_REASON_CODES = new Set([
  "guard.queueItemReserved",
  "sendQueuedNowRequiresRunning",
]);

/** Whether a final Steer ACK needs the retry toast; `itemStillQueued` reads the latest projection. */
export function shouldReportSteerFailure(ack: CommandAck, itemStillQueued: boolean): boolean {
  if (isQueueCommandSettledAck(ack.status)) return false;
  if (ack.reasonCode !== undefined && STEER_SUPERSEDED_REASON_CODES.has(ack.reasonCode))
    return false;
  return itemStillQueued;
}

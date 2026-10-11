// V4 physical assembly fault categories: **deterministic content failures** vs transient failures.
// spec: docs/v4-refactor/04-sync-and-recovery.md closed-rule 11 and
// docs/v4-refactor/05-transport-and-backpressure.md "Client rules".
//
// The recovery ladder treats faults as transient by default: try same-sub resync first (the server may return resume), then escalate after a gap
// to forceSnapshot, then fail closed if that still does not work. This escalation is right for missing chunks, timeouts, and checksum mismatches — retransmission may
// fix them. But it is wrong for **schema rejection**: the bytes already passed length/checksum/UTF-8/JSON checks, so rejection means
// this side cannot understand the **content** sent by the peer, and resume only resends the same deltas, which will be rejected again.
//
// The 2026-09-21 incident (sess_4142de31) was exactly this: a tool-card payload carried two extra
// keys, the recovery ladder burned three frames on the same content and failed closed, and after
// the user manually clicked "Reconnect" twice—three more burned frames each time—the session
// could never be opened again.
//
// This module answers only whether a reason code represents a deterministic content failure; it does not decide how to handle it — handling lives in the two stores.
// (conversationProjectionStore / sessionsIndexStore).

/**
 * Reason code for frame content that passed checksum/JSON but failed the zod schema.
 *
 * Use a constant instead of repeating a literal: the classification side and production side (wire-assembler, wire-reassembly) must always
 * use the same term; divergence between them is exactly the kind of silent mismatch this module is meant to fix.
 */
export const WIRE_FAULT_INVALID_PAYLOAD = "proto.frameAssemblyInvalidPayload";

/**
 * Whether this fault is a deterministic failure where "resending the same content will certainly be rejected again."
 *
 * Currently, only schema rejection qualifies. Intentionally **exclude** `proto.frameAssemblyInvalidJson`: invalid JSON
 * may also come from the assembly path itself (chunk joining, encoding boundaries), and retransmission may produce different bytes. Misclassifying a transient fault as deterministic would leave a recoverable gap stuck, which is worse than one unnecessary retry. Add cases based on evidence, not speculation.
 */
export function isDeterministicContentFault(reasonCode: string | undefined): boolean {
  return reasonCode === WIRE_FAULT_INVALID_PAYLOAD;
}

/**
 * Terminal client code for a deterministic content failure after all recovery attempts (`fault.subscription.*` belongs to the 04-sync vocabulary).
 *
 * Keeping it separate from `fault.subscription.recoveryFailed` is useful, not naming pedantry: the latter means "the connection did not recover,"
 * so reconnecting may help; this code means "this side cannot read the content sent by the peer," and reconnecting will produce the same result. Telemetry is grouped by
 * code, and combining them would make one version mismatch look like widespread network instability.
 */
export const SUBSCRIPTION_CONTENT_REJECTED = "fault.subscription.contentRejected";

/**
 * A WebSocket is `pending` after its one-time token is consumed and until it sends a valid
 * `auth_init`; then it is `authenticated` and owns one `(SID, role)` slot.
 */
export type ConnectionPhase = "pending" | "authenticated";

export type ClientFrameType = "auth_init" | "pair_status_query" | "data";

export function permitsFrame(phase: ConnectionPhase, type: ClientFrameType): boolean {
  if (phase === "pending") return type === "auth_init";
  return type === "pair_status_query" || type === "data";
}

/** Unix seconds as the wire carries them; never used for authorization. */
export function unixSeconds(nowMs: number): number {
  return Math.floor(nowMs / 1000);
}

export function webRemoteControlV2PairState(status: "waiting" | "matched") {
  return status === "matched" ? "paired" : "waiting_terminal";
}

/** Each transport instance owns its policy; auth_ack clears only the backoff, not the KICKED window. */
export class WebRemoteControlV2RetryPolicy {
  private failures = 0;
  private lastKickAt?: number;
  constructor(
    private readonly random: () => number = Math.random,
    private readonly backoff = { initialMs: 1000, maxMs: 30_000, jitter: 0.2 },
  ) {}
  acknowledged(): void {
    this.failures = 0;
  }
  nextDelay(): number {
    const base = Math.min(
      this.backoff.maxMs,
      this.backoff.initialMs * 2 ** Math.min(this.failures++, 16),
    );
    return Math.min(
      this.backoff.maxMs,
      Math.round(base * (1 - this.backoff.jitter + this.random() * this.backoff.jitter * 2)),
    );
  }
  kickedDelay(now = Date.now()): number | null {
    if (this.lastKickAt !== undefined && now - this.lastKickAt < 60_000) return null;
    this.lastKickAt = now;
    return 2000 + Math.floor(this.random() * 3001);
  }
}

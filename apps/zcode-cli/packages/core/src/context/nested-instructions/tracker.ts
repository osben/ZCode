// ============================================================
// Nested instructions: transient runtime state
// ============================================================
// The runtime owns one tracker. It holds only two things, and neither records what the model has seen (history does that):
// - reservations: files already selected by a call in the current tool schedule, with their injected bytes. Parallel calls
//   in one schedule would otherwise all see the same history, deliver the same file and overrun the context budget.
// - stat misses: candidate paths with no AGENTS.md, cached briefly so every tool call does not re-stat the whole ancestor chain.

export const NESTED_INSTRUCTION_MISS_TTL_MS = 30_000;
/** Above this many cached misses, expired entries are swept on insert so the cache stays bounded by live entries. */
const MISS_SWEEP_THRESHOLD = 512;

export type NestedReservationOutcome = "reserved" | "duplicate" | "over_budget";

export class NestedInstructionTracker {
  private readonly reservations = new Map<string, number>();
  private reservedByteTotal = 0;
  private readonly misses = new Map<string, number>();

  /** Injected bytes reserved by calls in the current schedule that history does not show yet. */
  get reservedBytes(): number {
    return this.reservedByteTotal;
  }

  /**
   * Check-and-add in one synchronous step. `availableBytes` is the budget left after the bytes already visible in history;
   * the reserved bytes of this schedule are subtracted here, so two calls cannot both spend the same remaining budget.
   * Call it only right before committing a file to the reminder, after the last await for that file.
   */
  reserve(key: string, bytes: number, availableBytes: number): NestedReservationOutcome {
    if (this.reservations.has(key)) return "duplicate";
    if (bytes + this.reservedByteTotal > availableBytes) return "over_budget";
    this.reservations.set(key, bytes);
    this.reservedByteTotal += bytes;
    return "reserved";
  }

  /**
   * Called by settleToolResults right after the step's tool results are committed to provider-visible history. Clearing
   * earlier (for example when one streamed tool's executeTools ends) would open a window where a later call in the same
   * step sees neither the reservation nor the result, and delivers the same file twice.
   */
  clearReservations(): void {
    this.reservations.clear();
    this.reservedByteTotal = 0;
  }

  isKnownMiss(key: string, now: number): boolean {
    const expiresAt = this.misses.get(key);
    if (expiresAt === undefined) return false;
    if (now >= expiresAt) {
      this.misses.delete(key);
      return false;
    }
    return true;
  }

  recordMiss(key: string, now: number): void {
    if (this.misses.size >= MISS_SWEEP_THRESHOLD) {
      for (const [missKey, expiresAt] of this.misses) {
        if (now >= expiresAt) this.misses.delete(missKey);
      }
    }
    this.misses.set(key, now + NESTED_INSTRUCTION_MISS_TTL_MS);
  }
}

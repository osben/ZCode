// ============================================================
// Nested instructions: transient runtime state
// ============================================================
// The runtime owns one tracker. It holds only two things, and neither records what the model has seen (history does that):
// - reservations: files already selected by a call in the current tool schedule. Parallel calls in one schedule would
//   otherwise all see the same history and deliver the same file.
// - stat misses: candidate paths with no AGENTS.md, cached briefly so every tool call does not re-stat the whole ancestor chain.

export const NESTED_INSTRUCTION_MISS_TTL_MS = 30_000;
/** Above this many cached misses, expired entries are swept on insert so the cache stays bounded by live entries. */
const MISS_SWEEP_THRESHOLD = 512;

export class NestedInstructionTracker {
  private readonly reservations = new Set<string>();
  private readonly misses = new Map<string, number>();

  /**
   * Check-and-add in one synchronous step. Returns false when another call in the same schedule already selected the key.
   * Call it only right before committing a file to the reminder, after the last await for that file.
   */
  reserve(key: string): boolean {
    if (this.reservations.has(key)) return false;
    this.reservations.add(key);
    return true;
  }

  /**
   * Called by settleToolResults right after the step's tool results are committed to provider-visible history. Clearing
   * earlier (for example when one streamed tool's executeTools ends) would open a window where a later call in the same
   * step sees neither the reservation nor the result, and delivers the same file twice.
   */
  clearReservations(): void {
    this.reservations.clear();
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

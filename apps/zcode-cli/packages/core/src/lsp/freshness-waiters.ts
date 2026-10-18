// ============================================================
// FreshnessWaiters: wakes bounded waits on freshness changes (no polling)
// ============================================================

export class FreshnessWaiters {
  private readonly waiters = new Set<() => void>();

  /**
   * Resolves with the predicate result when it holds, the timeout elapses, or the signal aborts.
   * Woken only by notify(). A non-positive timeout returns at once with the current result.
   */
  wait(predicate: () => boolean, timeoutMs: number, signal?: AbortSignal): Promise<boolean> {
    if (predicate()) return Promise.resolve(true);
    if (timeoutMs <= 0 || signal?.aborted) return Promise.resolve(false);
    return new Promise<boolean>((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const listener = (): void => {
        if (predicate()) finish();
      };
      const finish = (): void => {
        this.waiters.delete(listener);
        if (timer !== undefined) clearTimeout(timer);
        signal?.removeEventListener("abort", finish);
        resolve(predicate());
      };
      this.waiters.add(listener);
      timer = setTimeout(finish, timeoutMs);
      signal?.addEventListener("abort", finish, { once: true });
    });
  }

  /** Deleting a settled waiter during iteration is safe for a Set, so no copy is needed. */
  notify(): void {
    for (const waiter of this.waiters) waiter();
  }
}

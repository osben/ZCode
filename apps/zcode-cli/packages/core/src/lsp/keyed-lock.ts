// ============================================================
// KeyedLock: serializes async work per key (document sync ordering)
// ============================================================

export class KeyedLock {
  private readonly tails = new Map<string, Promise<void>>();

  /** Runs `task` after every earlier task for the same key has settled. */
  run<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    const result = previous.then(task);
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    this.tails.set(key, tail);
    void tail.then(() => {
      if (this.tails.get(key) === tail) this.tails.delete(key);
    });
    return result;
  }
}

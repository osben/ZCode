import type { Stats } from "node:fs";

export type ObserveLockInstance = (lockPath: string, lockStat: Stats, observedAt: number) => number;

export function createLockInstanceObserver(): ObserveLockInstance {
  const observations = new Map<string, { firstObservedAt: number; identity: string }>();

  return (lockPath, lockStat, observedAt) => {
    const identity = [lockStat.dev, lockStat.ino, lockStat.birthtimeMs, lockStat.mtimeMs].join(":");
    const previous = observations.get(lockPath);
    if (previous?.identity === identity) {
      return previous.firstObservedAt;
    }

    // When both timestamps are invalid, grace starts only when the current lock instance is first observed.
    // Reset when a later writer replaces the lock; do not inherit the waiter's elapsed time on the old lock.
    observations.set(lockPath, { firstObservedAt: observedAt, identity });
    return observedAt;
  };
}

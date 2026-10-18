# Dream lock leases

## Behavior

- A live `running` marker blocks another Dream attempt while its lease is younger than seven days.
- A running marker older than seven days is reclaimable even when its PID currently appears live, because the PID may have been reused or the prior owner may be stuck.
- A failed run restores the prior marker when possible. If restoration fails, the process remembers that lease as failed so its next Dream attempt can reclaim the same marker without waiting for the maximum lease age.
- Every owner writes a unique token; stale owners cannot restore or complete over a replacement lease.

## Acceptance scenarios

1. A fresh active marker cannot be reclaimed.
2. An active-looking marker older than seven days can be reclaimed, and the prior lease cannot overwrite its replacement.
3. After restoration fails for a lease, the same process can acquire a replacement lease on its next attempt.

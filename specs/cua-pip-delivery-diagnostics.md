# CUA PiP delivery skip diagnostics

## Behavior

`CuaPipSessionService` must keep credential or transport outages visible without emitting one production warning for every skipped focus event.

- The first skipped event for a reason (`credentials-unavailable` or `transport-disabled`) is logged at `warn` with its event context.
- Further skips with the same reason are logged at `debug` and include the aggregate skipped-event count.
- A skip with a different reason starts a new warning streak for that reason.
- After an event is successfully sent, emit one recovery warning with the streak reason and total skipped-event count, then clear the streak. Any successful send ends the streak, including the retry-timer replay of a deferred `turn-started` that happens without another published event.
- A deferred `turn-started` replay that fails during a timer-driven send remains staged and is retried until delivery or the existing replay deadline. The current event may still be delivered while the deferred opening event is retried, unless the current event is a `turn-ended` for that turn or a `session-closed` for that session; then the deferred event is discarded so a later retry cannot reopen a closed turn.
- Consecutive send failures use one warning followed by debug records with an increasing failure count. A later successful send emits one recovery info record and clears that failure streak. The existing skipped-event warning aggregation remains independent.

## Acceptance scenarios

1. Repeated skips with one reason produce one initial warning and debug records with an increasing count.
2. Successful delivery after a skip streak produces one recovery warning with the aggregate count; later skips begin a new warning streak.
3. A deferred `turn-started` event is still replayed before the next event after credentials return.
4. A retry-timer replay of the deferred `turn-started` (with no other published event) emits the recovery warning and ends the streak; the next skip warns again.
5. A timer-driven send failure preserves the deferred event and retries it; a later successful send reports recovery without changing skipped-event aggregation.
6. A deferred `turn-started` whose replay fails while the same turn's `turn-ended` (or the session's `session-closed`) is delivered is discarded and not retried.

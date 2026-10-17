# CUA PiP delivery skip diagnostics

## Behavior

`CuaPipSessionService` must keep credential or transport outages visible without emitting one production warning for every skipped focus event.

- The first skipped event for a reason (`credentials-unavailable` or `transport-disabled`) is logged at `warn` with its event context.
- Further skips with the same reason are logged at `debug` and include the aggregate skipped-event count.
- A skip with a different reason starts a new warning streak for that reason.
- After an event is successfully sent, emit one recovery warning with the streak reason and total skipped-event count, then clear the streak.
- Deferred `turn-started` replay, event ordering, and delivery behavior remain unchanged; this change only aggregates skip diagnostics.

## Acceptance scenarios

1. Repeated skips with one reason produce one initial warning and debug records with an increasing count.
2. Successful delivery after a skip streak produces one recovery warning with the aggregate count; later skips begin a new warning streak.
3. A deferred `turn-started` event is still replayed before the next event after credentials return.

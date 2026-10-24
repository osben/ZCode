# Goal Elapsed Accounting

V4 `GoalState` projects the current target's `timeUsedSeconds` and `activeRunStartedAtMs`. The CLI target reducer is the only authority for accumulated time; live deltas, cold snapshots and the desktop/web renderers consume the same fields.

```text
active elapsed = timeUsedSeconds + floor((now - activeRunStartedAtMs) / 1000)
paused/terminal elapsed = timeUsedSeconds
```

- The renderer may update `now` with a 1-second interval but must not write ticks back to the session, store, relay or main process.
- `pauseGoal` first makes the target reducer settle the current active interval into `timeUsedSeconds`, then enters paused; the UI then freezes the display.
- `resumeGoal` creates a new `activeRunStartedAtMs`; the accumulated value is not reset.
- Terminal states (verified, failed, ...) freeze the accumulated value; it must stay identical after reopen, cold restore and mobile replayable restore.
- When `activeRunStartedAtMs` is missing or later than now, show only the accumulated base; never a negative number or `NaN`.

`pauseGoal` is not equivalent to generic stop: pause explicitly changes the target's product state and can run with no current provider work; stop only terminates the current run and enters the existing queue hold/disposition flow.
